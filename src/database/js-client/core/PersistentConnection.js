/**
* Copyright 2017 Google Inc.
*
* Licensed under the Apache License, Version 2.0 (the "License");
* you may not use this file except in compliance with the License.
* You may obtain a copy of the License at
*
*   http://www.apache.org/licenses/LICENSE-2.0
*
* Unless required by applicable law or agreed to in writing, software
* distributed under the License is distributed on an "AS IS" BASIS,
* WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
* See the License for the specific language governing permissions and
* limitations under the License.
*/
goog.provide('fb.core.PersistentConnection');
goog.require('fb.core.ServerActions');
goog.require('fb.core.util');
goog.require('fb.core.util.OnlineMonitor');
goog.require('fb.core.util.VisibilityMonitor');
goog.require('fb.login.util.environment');
goog.require('fb.realtime.Connection');
goog.require('fb.util.json');
goog.require('fb.util.jwt');

var RECONNECT_MIN_DELAY = 1000;
var RECONNECT_MAX_DELAY_DEFAULT = 60 * 5 * 1000;   // 5 minutes in milliseconds (Case: 1858)
var RECONNECT_MAX_DELAY_FOR_ADMINS = 30 * 1000; // 30 seconds for admin clients (likely to be a backend server)
var RECONNECT_DELAY_MULTIPLIER = 1.3;
var RECONNECT_DELAY_RESET_TIMEOUT = 30000; // Reset delay back to MIN_DELAY after being connected for 30sec.
var SERVER_KILL_INTERRUPT_REASON = "server_kill";

// If auth fails repeatedly, we'll assume something is wrong and log a warning / back off.
var INVALID_AUTH_TOKEN_THRESHOLD = 3;

/**
 * Firebase connection.  Abstracts wire protocol and handles reconnecting.
 *
 * NOTE: All JSON objects sent to the realtime connection must have property names enclosed
 * in quotes to make sure the closure compiler does not minify them.
 */
fb.core.PersistentConnection = goog.defineClass(null, {
  /**
   * @implements {fb.core.ServerActions}
   * @param {!fb.core.RepoInfo} repoInfo Data about the namespace we are connecting to
   * @param {function(string, *, boolean, ?number)} onDataUpdate A callback for new data from the server
   */
  constructor: function(repoInfo, onDataUpdate, onConnectStatus,
                        onServerInfoUpdate, authTokenProvider, authOverride) {
    // Used for diagnostic logging.
    this.id = fb.core.PersistentConnection.nextPersistentConnectionId_++;
    this.log_ = fb.core.util.logWrapper('p:' + this.id + ':');
    /** @private {Object} */
    this.interruptReasons_ = { };
    this.listens_ = {};
    this.outstandingPuts_ = [];
    this.outstandingPutCount_ = 0;
    this.onDisconnectRequestQueue_ = [];
    this.connected_ = false;
    this.reconnectDelay_ = RECONNECT_MIN_DELAY;
    this.maxReconnectDelay_ = RECONNECT_MAX_DELAY_DEFAULT;
    this.onDataUpdate_ = onDataUpdate;
    this.onConnectStatus_ = onConnectStatus;
    this.onServerInfoUpdate_ = onServerInfoUpdate;
    this.repoInfo_ = repoInfo;
    this.securityDebugCallback_ = null;
    this.lastSessionId = null;
    /** @private {?{
     *   sendRequest: function(Object),
     *   close: function()
     * }} */
    this.realtime_ = null;
    /** @private {string|null} */
    this.authToken_ = null;
    this.authTokenProvider_ = authTokenProvider;
    this.forceTokenRefresh_ = false;
    this.invalidAuthTokenCount_ = 0;
    if (authOverride && !fb.login.util.environment.isNodeSdk()) {
      throw new Error('Auth override specified in options, but not supported on non Node.js platforms');
    }
    /** private {Object|null|undefined} */
    this.authOverride_ = authOverride;
    /** @private {number|null} */
    this.establishConnectionTimer_ = null;
    /** @private {boolean} */
    this.visible_ = false;

    // Before we get connected, we keep a queue of pending messages to send.
    this.requestCBHash_ = {};
    this.requestNumber_ = 0;

    this.firstConnection_ = true;
    this.lastConnectionAttemptTime_ = null;
    this.lastConnectionEstablishedTime_ = null;
    this.scheduleConnect_(0);

    fb.core.util.VisibilityMonitor.getInstance().on('visible', this.onVisible_, this);

    if (repoInfo.host.indexOf('fblocal') === -1) {
      fb.core.util.OnlineMonitor.getInstance().on('online', this.onOnline_, this);
    }
  },

  statics: {
    /**
     * @private
     */
    nextPersistentConnectionId_: 0,

    /**
     * Counter for number of connections created. Mainly used for tagging in the logs
     * @type {number}
     * @private
     */
    nextConnectionId_: 0
  },

  /**
   * @param {!string} action
   * @param {*} body
   * @param {function(*)=} onResponse
   * @protected
   */
  sendRequest: function(action, body, onResponse) {
    var curReqNum = ++this.requestNumber_;

    var msg = {'r': curReqNum, 'a': action, 'b': body};
    this.log_(fb.util.json.stringify(msg));
    fb.core.util.assert(this.connected_, "sendRequest call when we're not connected not allowed.");
    this.realtime_.sendRequest(msg);
    if (onResponse) {
      this.requestCBHash_[curReqNum] = onResponse;
    }
  },

  /**
   * @inheritDoc
   */
  listen: function(query, currentHashFn, tag, onComplete) {
    var queryId = query.queryIdentifier();
    var pathString = query.path.toString();
    this.log_('Listen called for ' + pathString + ' ' + queryId);
    this.listens_[pathString] = this.listens_[pathString] || {};
    fb.core.util.assert(query.getQueryParams().isDefault() || !query.getQueryParams().loadsAllData(),
        'listen() called for non-default but complete query');
    fb.core.util.assert(!this.listens_[pathString][queryId], 'listen() called twice for same path/queryId.');
    var listenSpec = {
      onComplete: onComplete,
      hashFn: currentHashFn,
      query: query,
      tag: tag
    };
    this.listens_[pathString][queryId] = listenSpec;

    if (this.connected_) {
      this.sendListen_(listenSpec);
    }
  },

  /**
   * @param {!{onComplete: function(),
   *           hashFn: function():!string,
   *           query: !fb.api.Query,
   *           tag: ?number}} listenSpec
   * @private
   */
  sendListen_: function(listenSpec) {
    var query = listenSpec.query;
    var pathString = query.path.toString();
    var queryId = query.queryIdentifier();
    var self = this;
    this.log_('Listen on ' + pathString + ' for ' + queryId);
    var req = {/*path*/ 'p': pathString};

    var action = 'q';

    // Only bother to send query if it's non-default.
    if (listenSpec.tag) {
      req['q'] = query.queryObject();
      req['t'] = listenSpec.tag;
    }

    req[/*hash*/'h'] = listenSpec.hashFn();

    this.sendRequest(action, req, function(message) {
      var payload = message[/*data*/ 'd'];
      var status = message[/*status*/ 's'];

      // print warnings in any case...
      self.warnOnListenWarnings_(payload, query);

      var currentListenSpec = self.listens_[pathString] && self.listens_[pathString][queryId];
      // only trigger actions if the listen hasn't been removed and readded
      if (currentListenSpec === listenSpec) {
        self.log_('listen response', message);

        if (status !== 'ok') {
          self.removeListen_(pathString, queryId);
        }

        if (listenSpec.onComplete) {
          listenSpec.onComplete(status, payload);
        }
      }
    });
  },

  /**
   * @param {*} payload
   * @param {!fb.api.Query} query
   * @private
   */
  warnOnListenWarnings_: function(payload, query) {
    if (payload && typeof payload === 'object' && fb.util.obj.contains(payload, 'w')) {
      var warnings = fb.util.obj.get(payload, 'w');
      if (goog.isArray(warnings) && goog.array.contains(warnings, 'no_index')) {
        var indexSpec = '".indexOn": "' + query.getQueryParams().getIndex().toString() + '"';
        var indexPath = query.path.toString();
        fb.core.util.warn('Using an unspecified index. Consider adding ' + indexSpec + ' at ' + indexPath +
            ' to your security rules for better performance');
      }
    }
  },

  /**
   * @inheritDoc
   */
  refreshAuthToken: function(token) {
    this.authToken_ = token;
    this.log_('Auth token refreshed');
    if (this.authToken_) {
      this.tryAuth();
    } else {
      //If we're connected we want to let the server know to unauthenticate us. If we're not connected, simply delete
      //the credential so we dont become authenticated next time we connect.
      if (this.connected_) {
        this.sendRequest('unauth', {}, function() { });
      }
    }

    this.reduceReconnectDelayIfAdminCredential_(token);
  },

  /**
   * @param {!string} credential
   * @private
   */
  reduceReconnectDelayIfAdminCredential_: function(credential) {
    // NOTE: This isn't intended to be bulletproof (a malicious developer can always just modify the client).
    // Additionally, we don't bother resetting the max delay back to the default if auth fails / expires.
    var isFirebaseSecret = credential && credential.length === 40;
    if (isFirebaseSecret || fb.util.jwt.isAdmin(credential)) {
      this.log_('Admin auth credential detected.  Reducing max reconnect time.');
      this.maxReconnectDelay_ = RECONNECT_MAX_DELAY_FOR_ADMINS;
    }
  },

  /**
   * Attempts to authenticate with the given credentials. If the authentication attempt fails, it's triggered like
   * a auth revoked (the connection is closed).
   */
  tryAuth: function() {
    var self = this;
    if (this.connected_ && this.authToken_) {
      var token = this.authToken_;
      var authMethod = fb.util.jwt.isValidFormat(token) ? 'auth' : 'gauth';
      var requestData = {'cred': token};
      if (this.authOverride_ === null) {
        requestData['noauth'] = true;
      } else if (typeof this.authOverride_ === 'object') {
        requestData['authvar'] = this.authOverride_;
      }
      this.sendRequest(authMethod, requestData, function(res) {
        var status = res[/*status*/ 's'];
        var data = res[/*data*/ 'd'] || 'error';

        if (self.authToken_ === token) {
          if (status === 'ok') {
            self.invalidAuthTokenCount_ = 0;
          } else {
            // Triggers reconnect and force refresh for auth token
            self.onAuthRevoked_(status, data);
          }
        }
      });
    }
  },

  /**
   * @inheritDoc
   */
  unlisten: function(query, tag) {
    var pathString = query.path.toString();
    var queryId = query.queryIdentifier();

    this.log_("Unlisten called for " + pathString + " " + queryId);

    fb.core.util.assert(query.getQueryParams().isDefault() || !query.getQueryParams().loadsAllData(),
        'unlisten() called for non-default but complete query');
    var listen = this.removeListen_(pathString, queryId);
    if (listen && this.connected_) {
      this.sendUnlisten_(pathString, queryId, query.queryObject(), tag);
    }
  },

  sendUnlisten_: function(pathString, queryId, queryObj, tag) {
    this.log_('Unlisten on ' + pathString + ' for ' + queryId);
    var self = this;

    var req = {/*path*/ 'p': pathString};
    var action = 'n';
    // Only bother send queryId if it's non-default.
    if (tag) {
      req['q'] = queryObj;
      req['t'] = tag;
    }

    this.sendRequest(action, req);
  },

  /**
   * @inheritDoc
   */
  onDisconnectPut: function(pathString, data, opt_onComplete) {
    if (this.connected_) {
      this.sendOnDisconnect_('o', pathString, data, opt_onComplete);
    } else {
      this.onDisconnectRequestQueue_.push({
        pathString: pathString,
        action: 'o',
        data: data,
        onComplete: opt_onComplete
      });
    }
  },

  /**
   * @inheritDoc
   */
  onDisconnectMerge: function(pathString, data, opt_onComplete) {
    if (this.connected_) {
      this.sendOnDisconnect_('om', pathString, data, opt_onComplete);
    } else {
      this.onDisconnectRequestQueue_.push({
        pathString: pathString,
        action: 'om',
        data: data,
        onComplete: opt_onComplete
      });
    }
  },

  /**
   * @inheritDoc
   */
  onDisconnectCancel: function(pathString, opt_onComplete) {
    if (this.connected_) {
      this.sendOnDisconnect_('oc', pathString, null, opt_onComplete);
    } else {
      this.onDisconnectRequestQueue_.push({
        pathString: pathString,
        action: 'oc',
        data: null,
        onComplete: opt_onComplete
      });
    }
  },

  sendOnDisconnect_: function(action, pathString, data, opt_onComplete) {
    var self = this;
    var request = {/*path*/ 'p': pathString, /*data*/ 'd': data};
    self.log_('onDisconnect ' + action, request);
    this.sendRequest(action, request, function(response) {
      if (opt_onComplete) {
        setTimeout(function() {
          opt_onComplete(response[/*status*/ 's'], response[/* data */'d']);
        }, Math.floor(0));
      }
    });
  },

  /**
   * @inheritDoc
   */
  put: function(pathString, data, opt_onComplete, opt_hash) {
    this.putInternal('p', pathString, data, opt_onComplete, opt_hash);
  },

  /**
   * @inheritDoc
   */
  merge: function(pathString, data, onComplete, opt_hash) {
    this.putInternal('m', pathString, data, onComplete, opt_hash);
  },

  putInternal: function(action, pathString, data, opt_onComplete, opt_hash) {
    var request = {/*path*/ 'p': pathString, /*data*/ 'd': data };

    if (goog.isDef(opt_hash))
      request[/*hash*/ 'h'] = opt_hash;

    // TODO: Only keep track of the most recent put for a given path?
    this.outstandingPuts_.push({
      action: action,
      request: request,
      onComplete: opt_onComplete
    });

    this.outstandingPutCount_++;
    var index = this.outstandingPuts_.length - 1;

    if (this.connected_) {
      this.sendPut_(index);
    } else {
      this.log_('Buffering put: ' + pathString);
    }
  },

  sendPut_: function(index) {
    var self = this;
    var action = this.outstandingPuts_[index].action;
    var request = this.outstandingPuts_[index].request;
    var onComplete = this.outstandingPuts_[index].onComplete;
    this.outstandingPuts_[index].queued = this.connected_;

    this.sendRequest(action, request, function(message) {
      self.log_(action + ' response', message);

      delete self.outstandingPuts_[index];
      self.outstandingPutCount_--;

      // Clean up array occasionally.
      if (self.outstandingPutCount_ === 0) {
        self.outstandingPuts_ = [];
      }

      if (onComplete)
        onComplete(message[/*status*/ 's'], message[/* data */ 'd']);
    });
  },

  /**
   * @inheritDoc
   */
  reportStats: function(stats) {
    // If we're not connected, we just drop the stats.
    if (this.connected_) {
      var request = { /*counters*/ 'c': stats };
      this.log_('reportStats', request);

      this.sendRequest(/*stats*/ 's', request, function(result) {
        var status = result[/*status*/ 's'];
        if (status !== 'ok') {
          var errorReason = result[/* data */ 'd'];
          this.log_('reportStats', 'Error sending stats: ' + errorReason);
        }
      });
    }
  },

  /**
   * @param {*} message
   * @private
   */
  onDataMessage_: function(message) {
    if ('r' in message) {
      // this is a response
      this.log_('from server: ' + fb.util.json.stringify(message));
      var reqNum = message['r'];
      var onResponse = this.requestCBHash_[reqNum];
      if (onResponse) {
        delete this.requestCBHash_[reqNum];
        onResponse(message[/*body*/ 'b']);
      }
    } else if ('error' in message) {
      throw 'A server-side error has occurred: ' + message['error'];
    } else if ('a' in message) {
      // a and b are action and body, respectively
      this.onDataPush_(message['a'], message['b']);
    }
  },

  onDataPush_: function(action, body) {
    this.log_('handleServerMessage', action, body);
    if (action === 'd')
      this.onDataUpdate_(body[/*path*/ 'p'], body[/*data*/ 'd'], /*isMerge*/false, body['t']);
    else if (action === 'm')
      this.onDataUpdate_(body[/*path*/ 'p'], body[/*data*/ 'd'], /*isMerge=*/true, body['t']);
    else if (action === 'c')
      this.onListenRevoked_(body[/*path*/ 'p'], body[/*query*/ 'q']);
    else if (action === 'ac')
      this.onAuthRevoked_(body[/*status code*/ 's'], body[/* explanation */ 'd']);
    else if (action === 'sd')
      this.onSecurityDebugPacket_(body);
    else
      fb.core.util.error('Unrecognized action received from server: ' + fb.util.json.stringify(action) +
        '\nAre you using the latest client?');
  },

  onReady_: function(timestamp, sessionId) {
    this.log_('connection ready');
    this.connected_ = true;
    this.lastConnectionEstablishedTime_ = new Date().getTime();
    this.handleTimestamp_(timestamp);
    this.lastSessionId = sessionId;
    if (this.firstConnection_) {
      this.sendConnectStats_();
    }
    this.restoreState_();
    this.firstConnection_ = false;
    this.onConnectStatus_(true);
  },

  scheduleConnect_: function(timeout) {
    fb.core.util.assert(!this.realtime_, "Scheduling a connect when we're already connected/ing?");

    if (this.establishConnectionTimer_) {
      clearTimeout(this.establishConnectionTimer_);
    }

    // NOTE: Even when timeout is 0, it's important to do a setTimeout to work around an infuriating "Security Error" in
    // Firefox when trying to write to our long-polling iframe in some scenarios (e.g. Forge or our unit tests).

    var self = this;
    this.establishConnectionTimer_ = setTimeout(function() {
      self.establishConnectionTimer_ = null;
      self.establishConnection_();
    }, Math.floor(timeout));
  },

  /**
   * @param {boolean} visible
   * @private
   */
  onVisible_: function(visible) {
    // NOTE: Tabbing away and back to a window will defeat our reconnect backoff, but I think that's fine.
    if (visible && !this.visible_ && this.reconnectDelay_ === this.maxReconnectDelay_) {
      this.log_('Window became visible.  Reducing delay.');
      this.reconnectDelay_ = RECONNECT_MIN_DELAY;

      if (!this.realtime_) {
        this.scheduleConnect_(0);
      }
    }
    this.visible_ = visible;
  },

  onOnline_: function(online) {
    if (online) {
      this.log_('Browser went online.');
      this.reconnectDelay_ = RECONNECT_MIN_DELAY;
      if (!this.realtime_) {
        this.scheduleConnect_(0);
      }
    } else {
      this.log_("Browser went offline.  Killing connection.");
      if (this.realtime_) {
        this.realtime_.close();
      }
    }
  },

  onRealtimeDisconnect_: function() {
    this.log_('data client disconnected');
    this.connected_ = false;
    this.realtime_ = null;

    // Since we don't know if our sent transactions succeeded or not, we need to cancel them.
    this.cancelSentTransactions_();

    // Clear out the pending requests.
    this.requestCBHash_ = {};

    if (this.shouldReconnect_()) {
      if (!this.visible_) {
        this.log_("Window isn't visible.  Delaying reconnect.");
        this.reconnectDelay_ = this.maxReconnectDelay_;
        this.lastConnectionAttemptTime_ = new Date().getTime();
      } else if (this.lastConnectionEstablishedTime_) {
        // If we've been connected long enough, reset reconnect delay to minimum.
        var timeSinceLastConnectSucceeded = new Date().getTime() - this.lastConnectionEstablishedTime_;
        if (timeSinceLastConnectSucceeded > RECONNECT_DELAY_RESET_TIMEOUT)
          this.reconnectDelay_ = RECONNECT_MIN_DELAY;
        this.lastConnectionEstablishedTime_ = null;
      }

      var timeSinceLastConnectAttempt = new Date().getTime() - this.lastConnectionAttemptTime_;
      var reconnectDelay = Math.max(0, this.reconnectDelay_ - timeSinceLastConnectAttempt);
      reconnectDelay = Math.random() * reconnectDelay;

      this.log_('Trying to reconnect in ' + reconnectDelay + 'ms');
      this.scheduleConnect_(reconnectDelay);

      // Adjust reconnect delay for next time.
      this.reconnectDelay_ = Math.min(this.maxReconnectDelay_, this.reconnectDelay_ * RECONNECT_DELAY_MULTIPLIER);
    }
    this.onConnectStatus_(false);
  },

  establishConnection_: function() {
    if (this.shouldReconnect_()) {
      this.log_('Making a connection attempt');
      this.lastConnectionAttemptTime_ = new Date().getTime();
      this.lastConnectionEstablishedTime_ = null;
      var onDataMessage = goog.bind(this.onDataMessage_, this);
      var onReady = goog.bind(this.onReady_, this);
      var onDisconnect = goog.bind(this.onRealtimeDisconnect_, this);
      var connId = this.id + ':' + fb.core.PersistentConnection.nextConnectionId_++;
      var self = this;
      var lastSessionId = this.lastSessionId;
      var canceled = false;
      var connection = null;
      var closeFn = function() {
        if (connection) {
          connection.close();
        } else {
          canceled = true;
          onDisconnect();
        }
      };
      var sendRequestFn = function(msg) {
        fb.core.util.assert(connection, "sendRequest call when we're not connected not allowed.");
        connection.sendRequest(msg);
      };

      this.realtime_ = {
        close: closeFn,
        sendRequest: sendRequestFn
      };

      var forceRefresh = this.forceTokenRefresh_;
      this.forceTokenRefresh_ = false;

      // First fetch auth token, and establish connection after fetching the token was successful
      this.authTokenProvider_.getToken(forceRefresh).then(function(result) {
        if (!canceled) {
          fb.core.util.log('getToken() completed. Creating connection.');
          self.authToken_ = result && result.accessToken;
          connection = new fb.realtime.Connection(connId, self.repoInfo_,
            onDataMessage,
            onReady,
            onDisconnect, /* onKill= */ function (reason) {
              fb.core.util.warn(reason + ' (' + self.repoInfo_.toString() + ')');
              self.interrupt(SERVER_KILL_INTERRUPT_REASON);
            },
            lastSessionId);
        } else {
          fb.core.util.log('getToken() completed but was canceled');
        }
      }).then(null, function(error) {
        self.log_('Failed to get token: ' + error);
        if (!canceled) {
          if (fb.constants.NODE_ADMIN) {
            // This may be a critical error for the Admin Node.js SDK, so log a warning.
            // But getToken() may also just have temporarily failed, so we still want to
            // continue retrying.
            fb.core.util.warn(error);
          }
          closeFn();
        }
      });
    }
  },

  /**
   * @param {string} reason
   */
  interrupt: function(reason) {
    fb.core.util.log('Interrupting connection for reason: ' + reason);
    this.interruptReasons_[reason] = true;
    if (this.realtime_) {
      this.realtime_.close();
    } else {
      if (this.establishConnectionTimer_) {
        clearTimeout(this.establishConnectionTimer_);
        this.establishConnectionTimer_ = null;
      }
      if (this.connected_) {
        this.onRealtimeDisconnect_();
      }
    }
  },

  /**
   * @param {string} reason
   */
  resume: function(reason) {
    fb.core.util.log('Resuming connection for reason: ' + reason);
    delete this.interruptReasons_[reason];
    if (goog.object.isEmpty(this.interruptReasons_)) {
      this.reconnectDelay_ = RECONNECT_MIN_DELAY;
      if (!this.realtime_) {
        this.scheduleConnect_(0);
      }
    }
  },

  /**
   * @param reason
   * @return {boolean}
   */
  isInterrupted: function(reason) {
    return this.interruptReasons_[reason] || false;
  },

  handleTimestamp_: function(timestamp) {
    var delta = timestamp - new Date().getTime();
    this.onServerInfoUpdate_({'serverTimeOffset': delta});
  },

  cancelSentTransactions_: function() {
    for (var i = 0; i < this.outstandingPuts_.length; i++) {
      var put = this.outstandingPuts_[i];
      if (put && /*hash*/'h' in put.request && put.queued) {
        if (put.onComplete)
          put.onComplete('disconnect');

        delete this.outstandingPuts_[i];
        this.outstandingPutCount_--;
      }
    }

    // Clean up array occasionally.
    if (this.outstandingPutCount_ === 0)
      this.outstandingPuts_ = [];
  },

  /**
  * @param {!string} pathString
  * @param {Array.<*>=} opt_query
  * @private
  */
  onListenRevoked_: function(pathString, opt_query) {
    // Remove the listen and manufacture a "permission_denied" error for the failed listen.
    var queryId;
    if (!opt_query) {
      queryId = 'default';
    } else {
      queryId = goog.array.map(opt_query, function(q) { return fb.core.util.ObjectToUniqueKey(q); }).join('$');
    }
    var listen = this.removeListen_(pathString, queryId);
    if (listen && listen.onComplete)
      listen.onComplete('permission_denied');
  },

  /**
   * @param {!string} pathString
   * @param {!string} queryId
   * @return {{queries:Array.<fb.api.Query>, onComplete:function(string)}}
   * @private
   */
  removeListen_: function(pathString, queryId) {
    var normalizedPathString = new fb.core.util.Path(pathString).toString(); // normalize path.
    var listen;
    if (goog.isDef(this.listens_[normalizedPathString])) {
      listen = this.listens_[normalizedPathString][queryId];
      delete this.listens_[normalizedPathString][queryId];
      if (goog.object.getCount(this.listens_[normalizedPathString]) === 0) {
        delete this.listens_[normalizedPathString];
      }
    } else {
      // all listens for this path has already been removed
      listen = undefined;
    }
    return listen;
  },

  onAuthRevoked_: function(statusCode, explanation) {
    fb.core.util.log('Auth token revoked: ' + statusCode + '/' + explanation);
    this.authToken_ = null;
    this.forceTokenRefresh_ = true;
    this.realtime_.close();
    if (statusCode === 'invalid_token' || statusCode === 'permission_denied') {
      // We'll wait a couple times before logging the warning / increasing the
      // retry period since oauth tokens will report as "invalid" if they're
      // just expired. Plus there may be transient issues that resolve themselves.
      this.invalidAuthTokenCount_++;
      if (this.invalidAuthTokenCount_ >= INVALID_AUTH_TOKEN_THRESHOLD) {
        // Set a long reconnect delay because recovery is unlikely
        this.reconnectDelay_ = RECONNECT_MAX_DELAY_FOR_ADMINS;

        // Notify the auth token provider that the token is invalid, which will log
        // a warning
        this.authTokenProvider_.notifyForInvalidToken();
      }
    }
  },

  onSecurityDebugPacket_: function(body) {
    if (this.securityDebugCallback_) {
      this.securityDebugCallback_(body);
    } else {
      if ('msg' in body && typeof console !== 'undefined') {
        console.log('FIREBASE: ' + body['msg'].replace('\n', '\nFIREBASE: '));
      }
    }
  },

  restoreState_: function() {
    //Re-authenticate ourselves if we have a credential stored.
    this.tryAuth();

    // Puts depend on having received the corresponding data update from the server before they complete, so we must
    // make sure to send listens before puts.
    var self = this;
    goog.object.forEach(this.listens_, function(queries, pathString) {
      goog.object.forEach(queries, function(listenSpec) {
        self.sendListen_(listenSpec);
      });
    });

    for (var i = 0; i < this.outstandingPuts_.length; i++) {
      if (this.outstandingPuts_[i])
        this.sendPut_(i);
    }

    while (this.onDisconnectRequestQueue_.length) {
      var request = this.onDisconnectRequestQueue_.shift();
      this.sendOnDisconnect_(request.action, request.pathString, request.data, request.onComplete);
    }
  },

  /**
   * Sends client stats for first connection
   * @private
   */
  sendConnectStats_: function() {
    var stats = {};

    var clientName = 'js';
    if (fb.constants.NODE_ADMIN) {
      clientName = 'admin_node';
    } else if (fb.constants.NODE_CLIENT) {
      clientName = 'node';
    }

    stats['sdk.' + clientName + '.' + firebase.SDK_VERSION.replace(/\./g, '-')] = 1;

    if (fb.login.util.environment.isMobileCordova()) {
      stats['framework.cordova'] = 1;
    }
    else if (fb.login.util.environment.isReactNative()) {
      stats['framework.reactnative'] = 1;
    }
    this.reportStats(stats);
  },

  /**
   * @return {boolean}
   * @private
   */
  shouldReconnect_: function() {
    var online = fb.core.util.OnlineMonitor.getInstance().currentlyOnline();
    return goog.object.isEmpty(this.interruptReasons_) && online;
  }
}); // end fb.core.PersistentConnection
