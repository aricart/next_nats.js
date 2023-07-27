/*
 * Copyright 2022-2023 The NATS Authors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { Empty, NatsError } from "../nats-base-client/types.ts";
import { BaseApiClient } from "./jsbaseclient_api.ts";
import {
  checkJsError,
  isFlowControlMsg,
  isHeartbeatMsg,
  isTerminal409,
  Js409Errors,
  millis,
  nanos,
  newJsErrorMsg,
  validateDurableName,
  validateStreamName,
} from "./jsutil.ts";
import { ConsumerAPI, ConsumerAPIImpl } from "./jsmconsumer_api.ts";
import { JsMsg, JsMsgImpl, toJsMsg } from "./jsmsg.ts";
import {
  MsgAdapter,
  TypedSubscription,
  TypedSubscriptionOptions,
} from "../nats-base-client/typedsub.ts";
import {
  IngestionFilterFn,
  IngestionFilterFnResult,
  QueuedIteratorImpl,
} from "../nats-base-client/queued_iterator.ts";
import { delay, Timeout, timeout } from "../nats-base-client/util.ts";
import { headers } from "../nats-base-client/headers.ts";
import { Bucket } from "./kv.ts";
import { NatsConnectionImpl } from "../nats-base-client/nats.ts";
import { Feature } from "../nats-base-client/semver.ts";
import { ObjectStoreImpl } from "./objectstore.ts";
import { IdleHeartbeat } from "../nats-base-client/idleheartbeat.ts";
import { ConsumersImpl, StreamAPIImpl, StreamsImpl } from "./jsmstream_api.ts";
import {
  ConsumerInfoable,
  ConsumerOpts,
  consumerOpts,
  ConsumerOptsBuilder,
  Consumers,
  Destroyable,
  isConsumerOptsBuilder,
  JetStreamClient,
  JetStreamManager,
  JetStreamPublishOptions,
  JetStreamPullSubscription,
  JetStreamSubscription,
  JetStreamSubscriptionInfo,
  JetStreamSubscriptionInfoable,
  JetStreamSubscriptionOptions,
  JsHeaders,
  KV,
  KvOptions,
  ObjectStore,
  ObjectStoreOptions,
  PubAck,
  Pullable,
  Streams,
  Views,
} from "./types.ts";
import {
  createInbox,
  ErrorCode,
  isNatsError,
  JetStreamOptions,
  Msg,
  NatsConnection,
  Payload,
  QueuedIterator,
  RequestOptions,
} from "../nats-base-client/core.ts";
import { SubscriptionImpl } from "../nats-base-client/protocol.ts";
import {
  AckPolicy,
  ConsumerConfig,
  ConsumerInfo,
  CreateConsumerRequest,
  DeliverPolicy,
  PullOptions,
  ReplayPolicy,
} from "./jsapi_types.ts";

enum PubHeaders {
  MsgIdHdr = "Nats-Msg-Id",
  ExpectedStreamHdr = "Nats-Expected-Stream",
  ExpectedLastSeqHdr = "Nats-Expected-Last-Sequence",
  ExpectedLastMsgIdHdr = "Nats-Expected-Last-Msg-Id",
  ExpectedLastSubjectSequenceHdr = "Nats-Expected-Last-Subject-Sequence",
}

class ViewsImpl implements Views {
  js: JetStreamClientImpl;
  jsm?: JetStreamManager;
  constructor(js: JetStreamClientImpl) {
    this.js = js;
  }
  kv(name: string, opts: Partial<KvOptions> = {}): Promise<KV> {
    const jsi = this.js as JetStreamClientImpl;
    const { ok, min } = jsi.nc.features.get(Feature.JS_KV);
    if (!ok) {
      return Promise.reject(
        new Error(`kv is only supported on servers ${min} or better`),
      );
    }
    if (opts.bindOnly) {
      return Bucket.bind(this.js, name);
    }

    return Bucket.create(this.js, name, opts);
  }
  os(
    name: string,
    opts: Partial<ObjectStoreOptions> = {},
  ): Promise<ObjectStore> {
    jetstreamPreview(this.js.nc);
    if (typeof crypto?.subtle?.digest !== "function") {
      return Promise.reject(
        new Error(
          "objectstore: unable to calculate hashes - crypto.subtle.digest with sha256 support is required",
        ),
      );
    }
    const jsi = this.js as JetStreamClientImpl;
    const { ok, min } = jsi.nc.features.get(Feature.JS_OBJECTSTORE);
    if (!ok) {
      return Promise.reject(
        new Error(`objectstore is only supported on servers ${min} or better`),
      );
    }
    return ObjectStoreImpl.create(this.js, name, opts);
  }
}

export class JetStreamClientImpl extends BaseApiClient
  implements JetStreamClient {
  consumers: Consumers;
  streams: Streams;
  consumerAPI: ConsumerAPI;
  streamAPI: StreamAPIImpl;
  constructor(nc: NatsConnection, opts?: JetStreamOptions) {
    super(nc, opts);
    this.consumerAPI = new ConsumerAPIImpl(nc, opts);
    this.streamAPI = new StreamAPIImpl(nc, opts);
    this.consumers = new ConsumersImpl(this.consumerAPI);
    this.streams = new StreamsImpl(this.streamAPI);
  }

  jetstreamManager(): Promise<JetStreamManager> {
    return this.nc.jetstreamManager(this.opts);
  }

  get apiPrefix(): string {
    return this.prefix;
  }

  get views(): Views {
    return new ViewsImpl(this);
  }

  async publish(
    subj: string,
    data: Payload = Empty,
    opts?: Partial<JetStreamPublishOptions>,
  ): Promise<PubAck> {
    opts = opts || {};
    opts.expect = opts.expect || {};
    const mh = opts?.headers || headers();
    if (opts) {
      if (opts.msgID) {
        mh.set(PubHeaders.MsgIdHdr, opts.msgID);
      }
      if (opts.expect.lastMsgID) {
        mh.set(PubHeaders.ExpectedLastMsgIdHdr, opts.expect.lastMsgID);
      }
      if (opts.expect.streamName) {
        mh.set(PubHeaders.ExpectedStreamHdr, opts.expect.streamName);
      }
      if (typeof opts.expect.lastSequence === "number") {
        mh.set(PubHeaders.ExpectedLastSeqHdr, `${opts.expect.lastSequence}`);
      }
      if (typeof opts.expect.lastSubjectSequence === "number") {
        mh.set(
          PubHeaders.ExpectedLastSubjectSequenceHdr,
          `${opts.expect.lastSubjectSequence}`,
        );
      }
    }

    const to = opts.timeout || this.timeout;
    const ro = {} as RequestOptions;
    if (to) {
      ro.timeout = to;
    }
    if (opts) {
      ro.headers = mh;
    }

    let { retries, retry_delay } = opts as {
      retries: number;
      retry_delay: number;
    };
    retries = retries || 1;
    retry_delay = retry_delay || 250;

    let r: Msg;
    for (let i = 0; i < retries; i++) {
      try {
        r = await this.nc.request(subj, data, ro);
        // if here we succeeded
        break;
      } catch (err) {
        const ne = err as NatsError;
        if (ne.code === "503" && i + 1 < retries) {
          await delay(retry_delay);
        } else {
          throw err;
        }
      }
    }
    const pa = this.parseJsResponse(r!) as PubAck;
    if (pa.stream === "") {
      throw NatsError.errorForCode(ErrorCode.JetStreamInvalidAck);
    }
    pa.duplicate = pa.duplicate ? pa.duplicate : false;
    return pa;
  }

  async pull(stream: string, durable: string, expires = 0): Promise<JsMsg> {
    validateStreamName(stream);
    validateDurableName(durable);

    let timeout = this.timeout;
    if (expires > timeout) {
      timeout = expires;
    }

    expires = expires < 0 ? 0 : nanos(expires);
    const pullOpts: Partial<PullOptions> = {
      batch: 1,
      no_wait: expires === 0,
      expires,
    };

    const msg = await this.nc.request(
      `${this.prefix}.CONSUMER.MSG.NEXT.${stream}.${durable}`,
      this.jc.encode(pullOpts),
      { noMux: true, timeout },
    );
    const err = checkJsError(msg);
    if (err) {
      throw (err);
    }
    return toJsMsg(msg);
  }

  /*
   * Returns available messages upto specified batch count.
   * If expires is set the iterator will wait for the specified
   * amount of millis before closing the subscription.
   * If no_wait is specified, the iterator will return no messages.
   * @param stream
   * @param durable
   * @param opts
   */
  fetch(
    stream: string,
    durable: string,
    opts: Partial<PullOptions> = {},
  ): QueuedIterator<JsMsg> {
    validateStreamName(stream);
    validateDurableName(durable);

    let timer: Timeout<void> | null = null;
    const trackBytes = (opts.max_bytes ?? 0) > 0;
    let receivedBytes = 0;
    const max_bytes = trackBytes ? opts.max_bytes! : 0;
    let monitor: IdleHeartbeat | null = null;

    const args: Partial<PullOptions> = {};
    args.batch = opts.batch || 1;
    if (max_bytes) {
      const fv = this.nc.features.get(Feature.JS_PULL_MAX_BYTES);
      if (!fv.ok) {
        throw new Error(
          `max_bytes is only supported on servers ${fv.min} or better`,
        );
      }
      args.max_bytes = max_bytes;
    }
    args.no_wait = opts.no_wait || false;
    if (args.no_wait && args.expires) {
      args.expires = 0;
    }
    const expires = opts.expires || 0;
    if (expires) {
      args.expires = nanos(expires);
    }
    if (expires === 0 && args.no_wait === false) {
      throw new Error("expires or no_wait is required");
    }
    const hb = opts.idle_heartbeat || 0;
    if (hb) {
      args.idle_heartbeat = nanos(hb);
      //@ts-ignore: for testing
      if (opts.delay_heartbeat === true) {
        //@ts-ignore: test option
        args.idle_heartbeat = nanos(hb * 4);
      }
    }

    const qi = new QueuedIteratorImpl<JsMsg>();
    const wants = args.batch;
    let received = 0;
    qi.protocolFilterFn = (jm, _ingest = false): boolean => {
      const jsmi = jm as JsMsgImpl;
      if (isHeartbeatMsg(jsmi.msg)) {
        monitor?.work();
        return false;
      }
      return true;
    };
    // FIXME: this looks weird, we want to stop the iterator
    //   but doing it from a dispatchedFn...
    qi.dispatchedFn = (m: JsMsg | null) => {
      if (m) {
        if (trackBytes) {
          receivedBytes += m.data.length;
        }
        received++;
        if (timer && m.info.pending === 0) {
          // the expiration will close it
          return;
        }
        // if we have one pending and we got the expected
        // or there are no more stop the iterator
        if (
          qi.getPending() === 1 && m.info.pending === 0 || wants === received ||
          (max_bytes > 0 && receivedBytes >= max_bytes)
        ) {
          qi.stop();
        }
      }
    };

    const inbox = createInbox(this.nc.options.inboxPrefix);
    const sub = this.nc.subscribe(inbox, {
      max: opts.batch,
      callback: (err: Error | null, msg) => {
        if (err === null) {
          err = checkJsError(msg);
        }
        if (err !== null) {
          if (timer) {
            timer.cancel();
            timer = null;
          }
          if (isNatsError(err)) {
            qi.stop(hideNonTerminalJsErrors(err) === null ? undefined : err);
          } else {
            qi.stop(err);
          }
        } else {
          // if we are doing heartbeats, message resets
          monitor?.work();
          qi.received++;
          qi.push(toJsMsg(msg));
        }
      },
    });

    // timer on the client  the issue is that the request
    // is started on the client, which means that it will expire
    // on the client first
    if (expires) {
      timer = timeout<void>(expires);
      timer.catch(() => {
        if (!sub.isClosed()) {
          sub.drain()
            .catch(() => {});
          timer = null;
        }
        if (monitor) {
          monitor.cancel();
        }
      });
    }

    (async () => {
      try {
        if (hb) {
          monitor = new IdleHeartbeat(hb, (v: number): boolean => {
            //@ts-ignore: pushing a fn
            qi.push(() => {
              // this will terminate the iterator
              qi.err = new NatsError(
                `${Js409Errors.IdleHeartbeatMissed}: ${v}`,
                ErrorCode.JetStreamIdleHeartBeat,
              );
            });
            return true;
          });
        }
      } catch (_err) {
        // ignore it
      }

      // close the iterator if the connection or subscription closes unexpectedly
      await (sub as SubscriptionImpl).closed;
      if (timer !== null) {
        timer.cancel();
        timer = null;
      }
      if (monitor) {
        monitor.cancel();
      }
      qi.stop();
    })().catch();

    this.nc.publish(
      `${this.prefix}.CONSUMER.MSG.NEXT.${stream}.${durable}`,
      this.jc.encode(args),
      { reply: inbox },
    );
    return qi;
  }

  async pullSubscribe(
    subject: string,
    opts: ConsumerOptsBuilder | Partial<ConsumerOpts> = consumerOpts(),
  ): Promise<JetStreamPullSubscription> {
    const cso = await this._processOptions(subject, opts);
    if (cso.ordered) {
      throw new Error("pull subscribers cannot be be ordered");
    }
    if (cso.config.deliver_subject) {
      throw new Error(
        "consumer info specifies deliver_subject - pull consumers cannot have deliver_subject set",
      );
    }

    const ackPolicy = cso.config.ack_policy;
    if (ackPolicy === AckPolicy.None || ackPolicy === AckPolicy.All) {
      throw new Error("ack policy for pull consumers must be explicit");
    }

    const so = this._buildTypedSubscriptionOpts(cso);
    const sub = new JetStreamPullSubscriptionImpl(
      this,
      cso.deliver,
      so,
    );
    sub.info = cso;

    try {
      await this._maybeCreateConsumer(cso);
    } catch (err) {
      sub.unsubscribe();
      throw err;
    }
    return sub as JetStreamPullSubscription;
  }

  async subscribe(
    subject: string,
    opts: ConsumerOptsBuilder | Partial<ConsumerOpts> = consumerOpts(),
  ): Promise<JetStreamSubscription> {
    const cso = await this._processOptions(subject, opts);
    // this effectively requires deliver subject to be specified
    // as an option otherwise we have a pull consumer
    if (!cso.isBind && !cso.config.deliver_subject) {
      throw new Error(
        "push consumer requires deliver_subject",
      );
    }

    const so = this._buildTypedSubscriptionOpts(cso);
    const sub = new JetStreamSubscriptionImpl(
      this,
      cso.deliver,
      so,
    );
    sub.info = cso;
    try {
      await this._maybeCreateConsumer(cso);
    } catch (err) {
      sub.unsubscribe();
      throw err;
    }

    sub._maybeSetupHbMonitoring();

    return sub;
  }

  async _processOptions(
    subject: string,
    opts: ConsumerOptsBuilder | Partial<ConsumerOpts> = consumerOpts(),
  ): Promise<JetStreamSubscriptionInfo> {
    const jsi =
      (isConsumerOptsBuilder(opts)
        ? opts.getOpts()
        : opts) as JetStreamSubscriptionInfo;
    jsi.isBind = isConsumerOptsBuilder(opts) ? opts.isBind : false;
    jsi.flow_control = {
      heartbeat_count: 0,
      fc_count: 0,
      consumer_restarts: 0,
    };
    if (jsi.ordered) {
      jsi.ordered_consumer_sequence = { stream_seq: 0, delivery_seq: 0 };
      if (
        jsi.config.ack_policy !== AckPolicy.NotSet &&
        jsi.config.ack_policy !== AckPolicy.None
      ) {
        throw new NatsError(
          "ordered consumer: ack_policy can only be set to 'none'",
          ErrorCode.ApiError,
        );
      }
      if (jsi.config.durable_name && jsi.config.durable_name.length > 0) {
        throw new NatsError(
          "ordered consumer: durable_name cannot be set",
          ErrorCode.ApiError,
        );
      }
      if (jsi.config.deliver_subject && jsi.config.deliver_subject.length > 0) {
        throw new NatsError(
          "ordered consumer: deliver_subject cannot be set",
          ErrorCode.ApiError,
        );
      }
      if (
        jsi.config.max_deliver !== undefined && jsi.config.max_deliver > 1
      ) {
        throw new NatsError(
          "ordered consumer: max_deliver cannot be set",
          ErrorCode.ApiError,
        );
      }
      if (jsi.config.deliver_group && jsi.config.deliver_group.length > 0) {
        throw new NatsError(
          "ordered consumer: deliver_group cannot be set",
          ErrorCode.ApiError,
        );
      }
      jsi.config.deliver_subject = createInbox(this.nc.options.inboxPrefix);
      jsi.config.ack_policy = AckPolicy.None;
      jsi.config.max_deliver = 1;
      jsi.config.flow_control = true;
      jsi.config.idle_heartbeat = jsi.config.idle_heartbeat || nanos(5000);
      jsi.config.ack_wait = nanos(22 * 60 * 60 * 1000);
      jsi.config.mem_storage = true;
      jsi.config.num_replicas = 1;
    }

    if (jsi.config.ack_policy === AckPolicy.NotSet) {
      jsi.config.ack_policy = AckPolicy.All;
    }

    jsi.api = this;
    jsi.config = jsi.config || {} as ConsumerConfig;
    jsi.stream = jsi.stream ? jsi.stream : await this.findStream(subject);

    jsi.attached = false;
    if (jsi.config.durable_name) {
      try {
        const info = await this.consumerAPI.info(
          jsi.stream,
          jsi.config.durable_name,
        );
        if (info) {
          if (
            info.config.filter_subject && info.config.filter_subject !== subject
          ) {
            throw new Error("subject does not match consumer");
          }
          // check if server returned push_bound, but there's no qn
          const qn = jsi.config.deliver_group ?? "";
          if (qn === "" && info.push_bound === true) {
            throw new Error(`duplicate subscription`);
          }

          const rqn = info.config.deliver_group ?? "";
          if (qn !== rqn) {
            if (rqn === "") {
              throw new Error(
                `durable requires no queue group`,
              );
            } else {
              throw new Error(
                `durable requires queue group '${rqn}'`,
              );
            }
          }
          jsi.last = info;
          jsi.config = info.config;
          jsi.attached = true;
          // if not a durable capture the name of the ephemeral so
          // that consumerInfo from the sub will work
          if (!jsi.config.durable_name) {
            jsi.name = info.name;
          }
        }
      } catch (err) {
        //consumer doesn't exist
        if (err.code !== "404") {
          throw err;
        }
      }
    }

    if (
      !jsi.attached && jsi.config.filter_subject === undefined &&
      jsi.config.filter_subjects === undefined
    ) {
      // if no filter specified, we set the subject as the filter
      jsi.config.filter_subject = subject;
    }

    jsi.deliver = jsi.config.deliver_subject ||
      createInbox(this.nc.options.inboxPrefix);

    return jsi;
  }

  _buildTypedSubscriptionOpts(
    jsi: JetStreamSubscriptionInfo,
  ): TypedSubscriptionOptions<JsMsg> {
    const so = {} as TypedSubscriptionOptions<JsMsg>;
    so.adapter = msgAdapter(jsi.callbackFn === undefined);
    so.ingestionFilterFn = JetStreamClientImpl.ingestionFn(jsi.ordered);
    so.protocolFilterFn = (jm, ingest = false): boolean => {
      const jsmi = jm as JsMsgImpl;
      if (isFlowControlMsg(jsmi.msg)) {
        if (!ingest) {
          jsmi.msg.respond();
        }
        return false;
      }
      return true;
    };
    if (!jsi.mack && jsi.config.ack_policy !== AckPolicy.None) {
      so.dispatchedFn = autoAckJsMsg;
    }
    if (jsi.callbackFn) {
      so.callback = jsi.callbackFn;
    }

    so.max = jsi.max || 0;
    so.queue = jsi.queue;
    return so;
  }

  async _maybeCreateConsumer(jsi: JetStreamSubscriptionInfo): Promise<void> {
    if (jsi.attached) {
      return;
    }
    if (jsi.isBind) {
      throw new Error(
        `unable to bind - durable consumer ${jsi.config.durable_name} doesn't exist in ${jsi.stream}`,
      );
    }
    jsi.config = Object.assign({
      deliver_policy: DeliverPolicy.All,
      ack_policy: AckPolicy.Explicit,
      ack_wait: nanos(30 * 1000),
      replay_policy: ReplayPolicy.Instant,
    }, jsi.config);

    const ci = await this.consumerAPI.add(jsi.stream, jsi.config);
    if (
      Array.isArray(
        jsi.config.filter_subjects && !Array.isArray(ci.config.filter_subjects),
      )
    ) {
      // server didn't honor `filter_subjects`
      throw new Error(
        `jetstream server doesn't support consumers with multiple filter subjects`,
      );
    }
    jsi.name = ci.name;
    jsi.config = ci.config;
    jsi.last = ci;
  }

  static ingestionFn(
    ordered: boolean,
  ): IngestionFilterFn<JsMsg> {
    return (jm: JsMsg | null, ctx?: unknown): IngestionFilterFnResult => {
      // ctx is expected to be the iterator (the JetstreamSubscriptionImpl)
      const jsub = ctx as JetStreamSubscriptionImpl;

      // this shouldn't happen
      if (!jm) return { ingest: false, protocol: false };

      const jmi = jm as JsMsgImpl;
      if (!checkJsError(jmi.msg)) {
        jsub.monitor?.work();
      }
      if (isHeartbeatMsg(jmi.msg)) {
        const ingest = ordered ? jsub._checkHbOrderConsumer(jmi.msg) : true;
        if (!ordered) {
          jsub!.info!.flow_control.heartbeat_count++;
        }
        return { ingest, protocol: true };
      } else if (isFlowControlMsg(jmi.msg)) {
        jsub!.info!.flow_control.fc_count++;
        return { ingest: true, protocol: true };
      }
      const ingest = ordered ? jsub._checkOrderedConsumer(jm) : true;
      return { ingest, protocol: false };
    };
  }
}

export class JetStreamSubscriptionImpl extends TypedSubscription<JsMsg>
  implements JetStreamSubscriptionInfoable, Destroyable, ConsumerInfoable {
  js: BaseApiClient;
  monitor: IdleHeartbeat | null;

  constructor(
    js: BaseApiClient,
    subject: string,
    opts: JetStreamSubscriptionOptions,
  ) {
    super(js.nc, subject, opts);
    this.js = js;
    this.monitor = null;

    this.sub.closed.then(() => {
      if (this.monitor) {
        this.monitor.cancel();
      }
    });
  }

  set info(info: JetStreamSubscriptionInfo | null) {
    (this.sub as SubscriptionImpl).info = info;
  }

  get info(): JetStreamSubscriptionInfo | null {
    return this.sub.info as JetStreamSubscriptionInfo;
  }

  _resetOrderedConsumer(sseq: number): void {
    if (this.info === null || this.sub.isClosed()) {
      return;
    }
    const newDeliver = createInbox(this.js.nc.options.inboxPrefix);
    const nci = this.js.nc;
    nci._resub(this.sub, newDeliver);
    const info = this.info;
    info.ordered_consumer_sequence.delivery_seq = 0;
    info.flow_control.heartbeat_count = 0;
    info.flow_control.fc_count = 0;
    info.flow_control.consumer_restarts++;
    info.deliver = newDeliver;
    info.config.deliver_subject = newDeliver;
    info.config.deliver_policy = DeliverPolicy.StartSequence;
    info.config.opt_start_seq = sseq;
    // put the stream name
    const req = {} as CreateConsumerRequest;
    req.stream_name = this.info.stream;
    req.config = info.config;

    const subj = `${info.api.prefix}.CONSUMER.CREATE.${info.stream}`;

    this.js._request(subj, req)
      .then((v) => {
        const ci = v as ConsumerInfo;
        this.info!.config = ci.config;
        this.info!.name = ci.name;
      })
      .catch((err) => {
        // to inform the subscription we inject an error this will
        // be at after the last message if using an iterator.
        const nerr = new NatsError(
          `unable to recreate ordered consumer ${info.stream} at seq ${sseq}`,
          ErrorCode.RequestError,
          err,
        );
        this.sub.callback(nerr, {} as Msg);
      });
  }

  // this is called by push subscriptions, to initialize the monitoring
  // if configured on the consumer
  _maybeSetupHbMonitoring() {
    const ns = this.info?.config?.idle_heartbeat || 0;
    if (ns) {
      this._setupHbMonitoring(millis(ns));
    }
  }

  _setupHbMonitoring(millis: number, cancelAfter = 0) {
    const opts = { cancelAfter: 0, maxOut: 2 };
    if (cancelAfter) {
      opts.cancelAfter = cancelAfter;
    }
    const sub = this.sub as SubscriptionImpl;
    const handler = (v: number): boolean => {
      const msg = newJsErrorMsg(
        409,
        `${Js409Errors.IdleHeartbeatMissed}: ${v}`,
        this.sub.subject,
      );
      const ordered = this.info?.ordered;
      // non-ordered consumers are always notified of the condition
      // as they need to try and recover
      if (!ordered) {
        this.sub.callback(null, msg);
      } else {
        if (!this.js.nc.protocol.connected) {
          // we are not connected don't do anything
          return false;
        }
        // reset the consumer
        const seq = this.info?.ordered_consumer_sequence?.stream_seq || 0;
        this._resetOrderedConsumer(seq + 1);
        // if we are ordered, we will reset the consumer and keep
        // feeding the iterator or callback - we are not stopping
        return false;
      }
      // let the hb monitor know if we are stopping for callbacks
      // we don't as we deliver the errors via the cb.
      return !sub.noIterator;
    };
    // this only applies for push subscriptions
    this.monitor = new IdleHeartbeat(millis, handler, opts);
  }

  _checkHbOrderConsumer(msg: Msg): boolean {
    const rm = msg.headers!.get(JsHeaders.ConsumerStalledHdr);
    if (rm !== "") {
      const nci = this.js.nc;
      nci.publish(rm);
    }
    const lastDelivered = parseInt(
      msg.headers!.get(JsHeaders.LastConsumerSeqHdr),
      10,
    );
    const ordered = this.info!.ordered_consumer_sequence;
    this.info!.flow_control.heartbeat_count++;
    if (lastDelivered !== ordered.delivery_seq) {
      this._resetOrderedConsumer(ordered.stream_seq + 1);
    }
    return false;
  }

  _checkOrderedConsumer(jm: JsMsg): boolean {
    const ordered = this.info!.ordered_consumer_sequence;
    const sseq = jm.info.streamSequence;
    const dseq = jm.info.deliverySequence;
    if (dseq != ordered.delivery_seq + 1) {
      this._resetOrderedConsumer(ordered.stream_seq + 1);
      return false;
    }
    ordered.delivery_seq = dseq;
    ordered.stream_seq = sseq;
    return true;
  }

  async destroy(): Promise<void> {
    if (!this.isClosed()) {
      await this.drain();
    }
    const jinfo = this.sub.info as JetStreamSubscriptionInfo;
    const name = jinfo.config.durable_name || jinfo.name;
    const subj = `${jinfo.api.prefix}.CONSUMER.DELETE.${jinfo.stream}.${name}`;
    await jinfo.api._request(subj);
  }

  async consumerInfo(): Promise<ConsumerInfo> {
    const jinfo = this.sub.info as JetStreamSubscriptionInfo;
    const name = jinfo.config.durable_name || jinfo.name;
    const subj = `${jinfo.api.prefix}.CONSUMER.INFO.${jinfo.stream}.${name}`;
    const ci = await jinfo.api._request(subj) as ConsumerInfo;
    jinfo.last = ci;
    return ci;
  }
}

class JetStreamPullSubscriptionImpl extends JetStreamSubscriptionImpl
  implements Pullable {
  constructor(
    js: BaseApiClient,
    subject: string,
    opts: TypedSubscriptionOptions<JsMsg>,
  ) {
    super(js, subject, opts);
  }
  pull(opts: Partial<PullOptions> = { batch: 1 }): void {
    const { stream, config, name } = this.sub.info as JetStreamSubscriptionInfo;
    const consumer = config.durable_name ?? name;
    const args: Partial<PullOptions> = {};
    args.batch = opts.batch || 1;
    args.no_wait = opts.no_wait || false;
    if ((opts.max_bytes ?? 0) > 0) {
      const fv = this.js.nc.features.get(Feature.JS_PULL_MAX_BYTES);
      if (!fv.ok) {
        throw new Error(
          `max_bytes is only supported on servers ${fv.min} or better`,
        );
      }
      args.max_bytes = opts.max_bytes!;
    }

    let expires = 0;
    if (opts.expires && opts.expires > 0) {
      expires = opts.expires;
      args.expires = nanos(expires);
    }

    let hb = 0;
    if (opts.idle_heartbeat && opts.idle_heartbeat > 0) {
      hb = opts.idle_heartbeat;
      args.idle_heartbeat = nanos(hb);
    }

    if (hb && expires === 0) {
      throw new Error("idle_heartbeat requires expires");
    }
    if (hb > expires) {
      throw new Error("expires must be greater than idle_heartbeat");
    }

    if (this.info) {
      if (this.monitor) {
        this.monitor.cancel();
      }
      if (expires && hb) {
        if (!this.monitor) {
          this._setupHbMonitoring(hb, expires);
        } else {
          this.monitor._change(hb, expires);
        }
      }

      const api = this.info.api as BaseApiClient;
      const subj = `${api.prefix}.CONSUMER.MSG.NEXT.${stream}.${consumer}`;
      const reply = this.sub.subject;

      api.nc.publish(
        subj,
        api.jc.encode(args),
        { reply: reply },
      );
    }
  }
}

function msgAdapter(iterator: boolean): MsgAdapter<JsMsg> {
  if (iterator) {
    return iterMsgAdapter;
  } else {
    return cbMsgAdapter;
  }
}

function cbMsgAdapter(
  err: NatsError | null,
  msg: Msg,
): [NatsError | null, JsMsg | null] {
  if (err) {
    return [err, null];
  }
  err = checkJsError(msg);
  if (err) {
    return [err, null];
  }
  // assuming that the protocolFilterFn is set!
  return [null, toJsMsg(msg)];
}

function iterMsgAdapter(
  err: NatsError | null,
  msg: Msg,
): [NatsError | null, JsMsg | null] {
  if (err) {
    return [err, null];
  }
  // iterator will close if we have an error
  // check for errors that shouldn't close it
  const ne = checkJsError(msg);
  if (ne !== null) {
    return [hideNonTerminalJsErrors(ne), null];
  }
  // assuming that the protocolFilterFn is set
  return [null, toJsMsg(msg)];
}

function hideNonTerminalJsErrors(ne: NatsError): NatsError | null {
  if (ne !== null) {
    switch (ne.code) {
      case ErrorCode.JetStream404NoMessages:
      case ErrorCode.JetStream408RequestTimeout:
        return null;
      case ErrorCode.JetStream409:
        if (isTerminal409(ne)) {
          return ne;
        }
        return null;
      default:
        return ne;
    }
  }
  return null;
}

function autoAckJsMsg(data: JsMsg | null) {
  if (data) {
    data.ack();
  }
}

const jetstreamPreview = (() => {
  let once = false;
  return (nci: NatsConnectionImpl) => {
    if (!once) {
      once = true;
      const { lang } = nci?.protocol?.transport;
      if (lang) {
        console.log(
          `\u001B[33m >> jetstream's materialized views object store functionality in ${lang} is beta functionality \u001B[0m`,
        );
      } else {
        console.log(
          `\u001B[33m >> jetstream's materialized views object store functionality is beta functionality \u001B[0m`,
        );
      }
    }
  };
})();