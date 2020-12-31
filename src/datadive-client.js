// Core of SDK code
import Constants from './constants';
import cookieStorage from './cookiestorage';
import MetadataStorage from '../src/metadata-storage';
import getUtmData from './utm'; // Urchin Tracking Module
import Identify from './identify';
import localStorage from './localstorage';  // jshint ignore:line
import md5 from 'blueimp-md5';
import Request from './xhr';
import Revenue from './revenue';
import type from './type';
import UAParser from '@amplitude/ua-parser-js'; // Identifying device and browser info (maybe move to backend?)
import utils from './utils';
import UUID from './uuid';
import base64Id from './base64Id';
import { version } from '../package.json';
import DEFAULT_OPTIONS from './options';
import getHost from './get-host';
import baseCookie from './base-cookie';

let AsyncStorage;
let Platform;
let DeviceInfo;
if (BUILD_COMPAT_REACT_NATIVE) {
  const reactNative = require('react-native');
  AsyncStorage = require('@react-native-community/async-storage').default;
  Platform = reactNative.Platform;
  DeviceInfo = require('react-native-device-info');
}

/**
 * DatadiveClient SDK API - instance constructor.
 * The Datadive class handles creation of client instances, all you need to do is call datadive.getInstance()
 * @constructor DatadiveClient
 * @public
 * @example var datadiveClient = new DatadiveClient();
 */
var DatadiveClient = function DatadiveClient(instanceName) {
  this._instanceName = utils.isEmptyString(instanceName) ? Constants.DEFAULT_INSTANCE : instanceName.toLowerCase();
  this._unsentEvents = [];
  this._unsentIdentifys = [];
  this._ua = new UAParser(navigator.userAgent).getResult();
  this.options = {...DEFAULT_OPTIONS, trackingOptions: {...DEFAULT_OPTIONS.trackingOptions}};
  this.cookieStorage = new cookieStorage().getStorage();
  this._q = []; // queue for proxied functions before script load
  this._sending = false;
  this._updateScheduled = false;
  this._onInit = [];

  // event meta data
  this._eventId = 0;
  this._identifyId = 0;
  this._lastEventTime = null;
  this._newSession = false;
  // sequence used for by frontend for prioritizing event send retries
  this._sequenceNumber = 0;
  this._sessionId = null;
  this._isInitialized = false;

  this._userAgent = (navigator && navigator.userAgent) || null;
};

DatadiveClient.prototype.Identify = Identify;
DatadiveClient.prototype.Revenue = Revenue;

/**
 * Initializes the Datadive Javascript SDK with your apiKey and any optional configurations.
 * This is required before any other methods can be called.
 * @public
 * @param {string} apiKey - The API key for your app.
 * @param {string} opt_userId - (optional) An identifier for this user.
 * @param {object} opt_config - (optional) Configuration options.
 * See [options.js](https://github.com/datadive-ai/dave-JavaScript/blob/master/src/options.js#L14) for list of options and default values.
 * @param {function} opt_callback - (optional) Provide a callback function to run after initialization is complete.
 * @example datadiveClient.init('API_KEY', 'USER_ID', {includeReferrer: true, includeUtm: true}, function() { alert('init complete'); });
 */
DatadiveClient.prototype.init = function init(apiKey, opt_userId, opt_config, opt_callback) {
  if (type(apiKey) !== 'string' || utils.isEmptyString(apiKey)) {
    utils.log.error('Invalid apiKey. Please re-initialize with a valid apiKey');
    return;
  }

  try {
    _parseConfig(this.options, opt_config);

    if (this.options.cookieName !== DEFAULT_OPTIONS.cookieName) {
      utils.log.warn('The cookieName option is deprecated. We will be ignoring it for newer cookies');
    }

    this.options.apiKey = apiKey;
    this._storageSuffix = '_' + apiKey + (this._instanceName === Constants.DEFAULT_INSTANCE ? '' : '_' + this._instanceName);
    this._storageSuffixV5 = apiKey.slice(0,6);

    this._oldCookiename = this.options.cookieName + this._storageSuffix;
    this._unsentKey = this.options.unsentKey + this._storageSuffix;
    this._unsentIdentifyKey = this.options.unsentIdentifyKey + this._storageSuffix;

    this._cookieName = Constants.COOKIE_PREFIX + '_' + this._storageSuffixV5;

    this.cookieStorage.options({
      expirationDays: this.options.cookieExpiration,
      domain: this.options.domain,
      secure: this.options.secureCookie,
      sameSite: this.options.sameSiteCookie
    });

    this._metadataStorage = new MetadataStorage({
      storageKey: this._cookieName,
      disableCookies: this.options.disableCookies,
      expirationDays: this.options.cookieExpiration,
      domain: this.options.domain,
      secure: this.options.secureCookie,
      sameSite: this.options.sameSiteCookie
    });

    const hasOldCookie = !!this.cookieStorage.get(this._oldCookiename);
    const hasNewCookie = !!this._metadataStorage.load();
    this._useOldCookie = (!hasNewCookie && hasOldCookie) && !this.options.cookieForceUpgrade;
    const hasCookie = hasNewCookie || hasOldCookie;
    this.options.domain = this.cookieStorage.options().domain;

    if (this.options.deferInitialization && !hasCookie) {
      this._deferInitialization(apiKey, opt_userId, opt_config, opt_callback);
      return;
    }

    if (type(this.options.logLevel) === 'string') {
      utils.setLogLevel(this.options.logLevel);
    }

    var trackingOptions = _generateApiPropertiesTrackingConfig(this);
    this._apiPropertiesTrackingOptions = Object.keys(trackingOptions).length > 0 ? {tracking_options: trackingOptions} : {};

    if (this.options.cookieForceUpgrade && hasOldCookie) {
      if (!hasNewCookie) {
        _upgradeCookieData(this);
      }
      this.cookieStorage.remove(this._oldCookiename);
    }

    _loadCookieData(this);
    this._pendingReadStorage = true;

    const initFromStorage = (storedDeviceId) => {
      this.options.deviceId = this._getInitialDeviceId(
         opt_config && opt_config.deviceId, storedDeviceId
      );
      this.options.userId =
        (type(opt_userId) === 'string' && !utils.isEmptyString(opt_userId) && opt_userId) ||
        (type(opt_userId) === 'number' && opt_userId.toString()) ||
          this.options.userId || null;

      var now = new Date().getTime();
      if (!this._sessionId || !this._lastEventTime || now - this._lastEventTime > this.options.sessionTimeout) {
        if (this.options.unsetParamsReferrerOnNewSession) {
          this._unsetUTMParams();
        }
        this._newSession = true;
        this._sessionId = now;

        // only capture UTM params and referrer if new session
        if (this.options.saveParamsReferrerOncePerSession) {
          this._trackParamsAndReferrer();
        }
      }

      if (!this.options.saveParamsReferrerOncePerSession) {
        this._trackParamsAndReferrer();
      }

      // load unsent events and identifies before any attempt to log new ones
      if (this.options.saveEvents) {
        _validateUnsentEventQueue(this._unsentEvents);
        _validateUnsentEventQueue(this._unsentIdentifys);
      }

      this._lastEventTime = now;
      _saveCookieData(this);

      this._pendingReadStorage = false;

      this._sendEventsIfReady(); // try sending unsent events

      for (let i = 0; i < this._onInit.length; i++) {
        this._onInit[i](this);
      }
      this._onInit = [];
      this._isInitialized = true;
    };

    if (AsyncStorage) {
      this._migrateUnsentEvents(() => {
        Promise.all([
            AsyncStorage.getItem(this._storageSuffix),
            AsyncStorage.getItem(this.options.unsentKey + this._storageSuffix),
            AsyncStorage.getItem(this.options.unsentIdentifyKey + this._storageSuffix),
        ]).then((values) => {
          if (values[0]) {
            const cookieData = JSON.parse(values[0]);
            if (cookieData) {
              _loadCookieDataProps(this, cookieData);
            }
          }
          if (this.options.saveEvents) {
            this._unsentEvents = this._parseSavedUnsentEventsString(values[1]).map(event => ({event})).concat(this._unsentEvents);
            this._unsentIdentifys = this._parseSavedUnsentEventsString(values[2]).map(event => ({event})).concat(this._unsentIdentifys);
          }
          if (DeviceInfo) {
            Promise.all([
              DeviceInfo.getCarrier(),
              DeviceInfo.getModel(),
              DeviceInfo.getManufacturer(),
              DeviceInfo.getVersion(),
              DeviceInfo.getUniqueId(),
            ]).then(values => {
              this.deviceInfo = {
                carrier: values[0],
                model: values[1],
                manufacturer: values[2],
                version: values[3]
              };
              initFromStorage(values[4]);
              this.runQueuedFunctions();
              if (type(opt_callback) === 'function') {
                opt_callback(this);
              }
            }).catch((err) => {
              this.options.onError(err);
            });
          } else {
            initFromStorage();
            this.runQueuedFunctions();
          }
        }).catch((err) => {
          this.options.onError(err);
        });
      });
    } else {
      if (this.options.saveEvents) {
        this._unsentEvents = this._loadSavedUnsentEvents(this.options.unsentKey).map(event => ({event})).concat(this._unsentEvents);
        this._unsentIdentifys = this._loadSavedUnsentEvents(this.options.unsentIdentifyKey).map(event => ({event})).concat(this._unsentIdentifys);
      }
      initFromStorage();
      this.runQueuedFunctions();
      if (type(opt_callback) === 'function') {
        opt_callback(this);
      }
    }
  } catch (err) {
    utils.log.error(err);
    this.options.onError(err);
  }
};

DatadiveClient.prototype.deleteLowerLevelDomainCookies = function () {
  const host = getHost();

  const cookieHost =
    (this.options.domain && this.options.domain[0] === '.') ?
      this.options.domain.slice(1) : this.options.domain;

  if (!cookieHost) {
    return;
  }

  if (host !== cookieHost) {
    if (new RegExp(cookieHost + '$').test(host)) {
      const hostParts = host.split('.');
      const cookieHostParts = cookieHost.split('.');

      for (let i = hostParts.length; i > cookieHostParts.length; --i) {
         const deleteDomain = hostParts.slice(hostParts.length - i).join('.');
         baseCookie.set(this._cookieName, null, {domain: '.' + deleteDomain});
      }
      baseCookie.set(this._cookieName, null, {});
    }
  }
};

DatadiveClient.prototype._getInitialDeviceId = function (configDeviceId, storedDeviceId) {
  if (configDeviceId) {
    return configDeviceId;
  }

  if (this.options.deviceIdFromUrlParam) {
    let deviceIdFromUrlParam = this._getDeviceIdFromUrlParam(this._getUrlParams());
    if (deviceIdFromUrlParam) {
        return deviceIdFromUrlParam;
    }
  }

  if (this.options.deviceId) {
    return this.options.deviceId;
  }

  if (storedDeviceId) {
    return storedDeviceId;
  }

  return base64Id();
};

// validate properties for unsent events
const _validateUnsentEventQueue = (queue) => {
  for (let i = 0; i < queue.length; i++) {
    const userProperties = queue[i].event.user_properties;
    const eventProperties = queue[i].event.event_properties;
    const groups = queue[i].event.groups;

    queue[i].event.user_properties = utils.validateProperties(userProperties);
    queue[i].event.event_properties = utils.validateProperties(eventProperties);
    queue[i].event.groups = utils.validateGroups(groups);
  }
};

/**
 * @private
 */
DatadiveClient.prototype._migrateUnsentEvents = function _migrateUnsentEvents(cb) {
  Promise.all([
      AsyncStorage.getItem(this.options.unsentKey),
      AsyncStorage.getItem(this.options.unsentIdentifyKey),
  ]).then((values) => {
    if (this.options.saveEvents) {
      var unsentEventsString = values[0];
      var unsentIdentifyKey = values[1];

      var itemsToSet = [];
      var itemsToRemove = [];

      if (!!unsentEventsString) {
        itemsToSet.push(AsyncStorage.setItem(this.options.unsentKey + this._storageSuffix, JSON.stringify(unsentEventsString)));
        itemsToRemove.push(AsyncStorage.removeItem(this.options.unsentKey));
      }

      if (!!unsentIdentifyKey) {
        itemsToSet.push(AsyncStorage.setItem(this.options.unsentIdentifyKey + this._storageSuffix, JSON.stringify(unsentIdentifyKey)));
        itemsToRemove.push(AsyncStorage.removeItem(this.options.unsentIdentifyKey));
      }

      if (itemsToSet.length > 0) {
        Promise.all(itemsToSet).then(() => {
          Promise.all(itemsToRemove);
        }).catch((err) => {
          this.options.onError(err);
        });
      }
    }
  })
  .then(cb)
  .catch((err) => {
    this.options.onError(err);
  });
};

/**
 * @private
 */
DatadiveClient.prototype._getUrl = function _getUrl(eventType) {
  const url = {
    host: window.location.host,
    pathname: window.location.pathname,
  };
  if (window.location.search) {
    url.search = window.location.search;
  }
  return eventType === Constants.IDENTIFY_EVENT ? {} : {
    ...url,
  };
};

/**
 * @private
 */
DatadiveClient.prototype._getParamsAndReferrer = function _getParamsAndReferrer(eventType) {
  let utmProperties;
  let referrerProperties;
  let gclidProperties;
  const queryParams = this._getUrlParams();
  const cookieParams = this.cookieStorage.get('__utmz');
  const referrer = this._getReferrer();
  const gclid = utils.getQueryParam('gclid', this._getUrlParams());
  utmProperties = getUtmData(cookieParams, queryParams);
  referrerProperties = utils.isEmptyString(referrer) ? undefined : {
    'referrer': referrer,
    'referring_domain': this._getReferringDomain(referrer)
  };
  gclidProperties = utils.isEmptyString(gclid) ? undefined : {'gclid': gclid};
  return eventType === Constants.IDENTIFY_EVENT ? {} : {
    ...utmProperties,
    ...referrerProperties,
    ...gclidProperties,
  };
};

/**
 * @private
 */
DatadiveClient.prototype._trackParamsAndReferrer = function _trackParamsAndReferrer() {
  let utmProperties;
  let referrerProperties;
  let gclidProperties;
  if (this.options.includeUtm) {
    utmProperties = this._initUtmData();
  }
  if (this.options.includeReferrer) {
    referrerProperties = this._saveReferrer(this._getReferrer());
  }
  if (this.options.includeGclid) {
    gclidProperties = this._saveGclid(this._getUrlParams());
  }
  if (this.options.logAttributionCapturedEvent) {
    const attributionProperties = {
      ...utmProperties,
      ...referrerProperties,
      ...gclidProperties,
    };
    if (Object.keys(attributionProperties).length > 0) {
      this.logEvent(Constants.ATTRIBUTION_EVENT, attributionProperties);
    }
  }
};

/**
 * Parse and validate user specified config values and overwrite existing option value
 * DEFAULT_OPTIONS provides list of all config keys that are modifiable, as well as expected types for values
 * @private
 */
var _parseConfig = function _parseConfig(options, config) {
  if (type(config) !== 'object') {
    return;
  }

  // validates config value is defined, is the correct type, and some additional value sanity checks
  var parseValidateAndLoad = function parseValidateAndLoad(key) {
    if (!options.hasOwnProperty(key)) {
      return;  // skip bogus config values
    }

    var inputValue = config[key];
    var expectedType = type(options[key]);
    if (!utils.validateInput(inputValue, key + ' option', expectedType)) {
      return;
    }
    if (expectedType === 'boolean') {
      options[key] = !!inputValue;
    } else if ((expectedType === 'string' && !utils.isEmptyString(inputValue)) ||
        (expectedType === 'number' && inputValue > 0)) {
      options[key] = inputValue;
    } else if (expectedType === 'object') {
      _parseConfig(options[key], inputValue);
    }
  };

  for (var key in config) {
    if (config.hasOwnProperty(key)) {
      parseValidateAndLoad(key);
    }
  }
};

/**
 * Run functions queued up by proxy loading snippet
 * @private
 */
DatadiveClient.prototype.runQueuedFunctions = function () {
  const queue = this._q;
  this._q = [];

  for (var i = 0; i < queue.length; i++) {
    var fn = this[queue[i][0]];
    if (type(fn) === 'function') {
      fn.apply(this, queue[i].slice(1));
    }
  }
};

/**
 * Check that the apiKey is set before calling a function. Logs a warning message if not set.
 * @private
 */
DatadiveClient.prototype._apiKeySet = function _apiKeySet(methodName) {
  if (utils.isEmptyString(this.options.apiKey)) {
    utils.log.error('Invalid apiKey. Please set a valid apiKey with init() before calling ' + methodName);
    return false;
  }
  return true;
};

/**
 * Load saved events from localStorage. JSON deserializes event array. Handles case where string is corrupted.
 * @private
 */
DatadiveClient.prototype._loadSavedUnsentEvents = function _loadSavedUnsentEvents(unsentKey) {
  var savedUnsentEventsString = this._getFromStorage(localStorage, unsentKey);
  var unsentEvents = this._parseSavedUnsentEventsString(savedUnsentEventsString, unsentKey);

  this._setInStorage(localStorage, unsentKey, JSON.stringify(unsentEvents));

  return unsentEvents;
};

/**
 * Load saved events from localStorage. JSON deserializes event array. Handles case where string is corrupted.
 * @private
 */
DatadiveClient.prototype._parseSavedUnsentEventsString = function _parseSavedUnsentEventsString(savedUnsentEventsString, unsentKey) {
  if (utils.isEmptyString(savedUnsentEventsString)) {
    return []; // new app, does not have any saved events
  }

  if (type(savedUnsentEventsString) === 'string') {
    try {
      var events = JSON.parse(savedUnsentEventsString);
      if (type(events) === 'array') { // handle case where JSON dumping of unsent events is corrupted
        return events;
      }
    } catch (e) {}
  }
  utils.log.error('Unable to load ' + unsentKey + ' events. Restart with a new empty queue.');
  return [];
};

/**
 * Returns true if a new session was created during initialization, otherwise false.
 * @public
 * @return {boolean} Whether a new session was created during initialization.
 */
DatadiveClient.prototype.isNewSession = function isNewSession() {
  return this._newSession;
};

/**
 * Add callbacks to call after init. Useful for users who load Datadive through a snippet.
 * @public
 */
DatadiveClient.prototype.onInit = function (callback) {
  if (this._isInitialized) {
    callback(this);
  } else {
    this._onInit.push(callback);
  }
};

/**
 * Returns the id of the current session.
 * @public
 * @return {number} Id of the current session.
 */
DatadiveClient.prototype.getSessionId = function getSessionId() {
  return this._sessionId;
};

/**
 * Increments the eventId and returns it.
 * @private
 */
DatadiveClient.prototype.nextEventId = function nextEventId() {
  this._eventId++;
  return this._eventId;
};

/**
 * Increments the identifyId and returns it.
 * @private
 */
DatadiveClient.prototype.nextIdentifyId = function nextIdentifyId() {
  this._identifyId++;
  return this._identifyId;
};

/**
 * Increments the sequenceNumber and returns it.
 * @private
 */
DatadiveClient.prototype.nextSequenceNumber = function nextSequenceNumber() {
  this._sequenceNumber++;
  return this._sequenceNumber;
};

/**
 * Returns the total count of unsent events and identifys
 * @private
 */
DatadiveClient.prototype._unsentCount = function _unsentCount() {
  return this._unsentEvents.length + this._unsentIdentifys.length;
};

/**
 * Send events if ready. Returns true if events are sent.
 * @private
 */
DatadiveClient.prototype._sendEventsIfReady = function _sendEventsIfReady() {
  if (this._unsentCount() === 0) {
    return false;
  }

  // if batching disabled, send any unsent events immediately
  if (!this.options.batchEvents) {
    this.sendEvents();
    return true;
  }

  // if batching enabled, check if min threshold met for batch size
  if (this._unsentCount() >= this.options.eventUploadThreshold) {
    this.sendEvents();
    return true;
  }

  // otherwise schedule an upload after 30s
  if (!this._updateScheduled) {  // make sure we only schedule 1 upload
    this._updateScheduled = true;
    setTimeout(function() {
        this._updateScheduled = false;
        this.sendEvents();
      }.bind(this), this.options.eventUploadPeriodMillis
    );
  }

  return false; // an upload was scheduled, no events were uploaded
};

/**
 * Helper function to fetch values from storage
 * Storage argument allows for localStoraoge and sessionStoraoge
 * @private
 */
DatadiveClient.prototype._getFromStorage = function _getFromStorage(storage, key) {
  return storage.getItem(key + this._storageSuffix);
};

/**
 * Helper function to set values in storage
 * Storage argument allows for localStoraoge and sessionStoraoge
 * @private
 */
DatadiveClient.prototype._setInStorage = function _setInStorage(storage, key, value) {
  storage.setItem(key + this._storageSuffix, value);
};

/**
 * Fetches deviceId, userId, event meta data from datadive cookie
 * @private
 */
var _loadCookieData = function _loadCookieData(scope) {
  if (!scope._useOldCookie) {
    const props = scope._metadataStorage.load();
    if (type(props) === 'object') {
      _loadCookieDataProps(scope, props);
    }
    return;
  }

  var cookieData = scope.cookieStorage.get(scope._oldCookiename);
  if (type(cookieData) === 'object') {
    _loadCookieDataProps(scope, cookieData);
    return;
  }
};

const _upgradeCookieData = (scope) => {
  var cookieData = scope.cookieStorage.get(scope._oldCookiename);
  if (type(cookieData) === 'object') {
    _loadCookieDataProps(scope, cookieData);
    _saveCookieData(scope);
  }
};

var _loadCookieDataProps = function _loadCookieDataProps(scope, cookieData) {
  if (cookieData.deviceId) {
    scope.options.deviceId = cookieData.deviceId;
  }
  if (cookieData.userId) {
    scope.options.userId = cookieData.userId;
  }
  if (cookieData.optOut !== null && cookieData.optOut !== undefined) {
    // Do not clobber config opt out value if cookieData has optOut as false
    if (cookieData.optOut !== false) {
      scope.options.optOut = cookieData.optOut;
    }
  }
  if (cookieData.sessionId) {
    scope._sessionId = parseInt(cookieData.sessionId, 10);
  }
  if (cookieData.lastEventTime) {
    scope._lastEventTime = parseInt(cookieData.lastEventTime, 10);
  }
  if (cookieData.eventId) {
    scope._eventId = parseInt(cookieData.eventId, 10);
  }
  if (cookieData.identifyId) {
    scope._identifyId = parseInt(cookieData.identifyId, 10);
  }
  if (cookieData.sequenceNumber) {
    scope._sequenceNumber = parseInt(cookieData.sequenceNumber, 10);
  }
};

/**
 * Saves deviceId, userId, event meta data to datadive cookie
 * @private
 */
var _saveCookieData = function _saveCookieData(scope) {
  const cookieData = {
    deviceId: scope.options.deviceId,
    userId: scope.options.userId,
    optOut: scope.options.optOut,
    sessionId: scope._sessionId,
    lastEventTime: scope._lastEventTime,
    eventId: scope._eventId,
    identifyId: scope._identifyId,
    sequenceNumber: scope._sequenceNumber
  };
  if (AsyncStorage) {
    AsyncStorage.setItem(scope._storageSuffix, JSON.stringify(cookieData));
  }

  if (scope._useOldCookie) {
    scope.cookieStorage.set(scope.options.cookieName + scope._storageSuffix, cookieData);
  } else {
    scope._metadataStorage.save(cookieData);
  }
};

/**
 * Parse the utm properties out of cookies and query for adding to user properties.
 * @private
 */
DatadiveClient.prototype._initUtmData = function _initUtmData(queryParams, cookieParams) {
  queryParams = queryParams || this._getUrlParams();
  cookieParams = cookieParams || this.cookieStorage.get('__utmz');
  var utmProperties = getUtmData(cookieParams, queryParams);
  _sendParamsReferrerUserProperties(this, utmProperties);
  return utmProperties;
};

/**
 * Unset the utm params from the Datadive instance and update the identify.
 * @private
 */
DatadiveClient.prototype._unsetUTMParams = function _unsetUTMParams() {
  var identify = new Identify();
  identify.unset(Constants.REFERRER);
  identify.unset(Constants.UTM_SOURCE);
  identify.unset(Constants.UTM_MEDIUM);
  identify.unset(Constants.UTM_CAMPAIGN);
  identify.unset(Constants.UTM_TERM);
  identify.unset(Constants.UTM_CONTENT);
  this.identify(identify);
};

/**
 * The calling function should determine when it is appropriate to send these user properties. This function
 * will no longer contain any session storage checking logic.
 * @private
 */
var _sendParamsReferrerUserProperties = function _sendParamsReferrerUserProperties(scope, userProperties) {
  if (type(userProperties) !== 'object' || Object.keys(userProperties).length === 0) {
    return;
  }

  // setOnce the initial user properties
  var identify = new Identify();
  for (var key in userProperties) {
    if (userProperties.hasOwnProperty(key)) {
      identify.setOnce('initial_' + key, userProperties[key]);
      identify.set(key, userProperties[key]);
    }
  }

  scope.identify(identify);
};

/**
 * @private
 */
DatadiveClient.prototype._getReferrer = function _getReferrer() {
  return document.referrer;
};

/**
 * @private
 */
DatadiveClient.prototype._getUrlParams = function _getUrlParams() {
  return location.search;
};

/**
 * Try to fetch Google Gclid from url params.
 * @private
 */
DatadiveClient.prototype._saveGclid = function _saveGclid(urlParams) {
  var gclid = utils.getQueryParam('gclid', urlParams);
  if (utils.isEmptyString(gclid)) {
    return;
  }
  var gclidProperties = {'gclid': gclid};
  _sendParamsReferrerUserProperties(this, gclidProperties);
  return gclidProperties;
};

/**
 * Try to fetch Datadive device id from url params.
 * @private
 */
DatadiveClient.prototype._getDeviceIdFromUrlParam = function _getDeviceIdFromUrlParam(urlParams) {
  return utils.getQueryParam(Constants.DAVE_DEVICE_ID_PARAM, urlParams);
};

/**
 * Parse the domain from referrer info
 * @private
 */
DatadiveClient.prototype._getReferringDomain = function _getReferringDomain(referrer) {
  if (utils.isEmptyString(referrer)) {
    return null;
  }
  var parts = referrer.split('/');
  if (parts.length >= 3) {
    return parts[2];
  }
  return null;
};

/**
 * Fetch the referrer information, parse the domain and send.
 * Since user properties are propagated on the server, only send once per session, don't need to send with every event
 * @private
 */
DatadiveClient.prototype._saveReferrer = function _saveReferrer(referrer) {
  if (utils.isEmptyString(referrer)) {
    return;
  }
  var referrerInfo = {
    'referrer': referrer,
    'referring_domain': this._getReferringDomain(referrer)
  };
  _sendParamsReferrerUserProperties(this, referrerInfo);
  return referrerInfo;
};

/**
 * Saves unsent events and identifies to localStorage. JSON stringifies event queues before saving.
 * Note: this is called automatically every time events are logged, unless you explicitly set option saveEvents to false.
 * @private
 */
DatadiveClient.prototype.saveEvents = function saveEvents() {
  try {
    const serializedUnsentEvents = JSON.stringify(this._unsentEvents.map(({event}) => event));

    if (AsyncStorage) {
      AsyncStorage.setItem(this.options.unsentKey + this._storageSuffix, serializedUnsentEvents);
    } else {
      this._setInStorage(localStorage, this.options.unsentKey, serializedUnsentEvents);
    }
  } catch (e) {}

  try {
    const serializedIdentifys = JSON.stringify(this._unsentIdentifys.map(unsentIdentify => unsentIdentify.event));

    if (AsyncStorage) {
      AsyncStorage.setItem(this.options.unsentIdentifyKey + this._storageSuffix, serializedIdentifys);
    } else {
      this._setInStorage(localStorage, this.options.unsentIdentifyKey, serializedIdentifys);
    }
  } catch (e) {}
};

/**
 * Sets a customer domain for the datadive cookie. Useful if you want to support cross-subdomain tracking.
 * @public
 * @param {string} domain to set.
 * @example datadiveClient.setDomain('.datadive.ai');
 */
DatadiveClient.prototype.setDomain = function setDomain(domain) {
  if (this._shouldDeferCall()) {
    return this._q.push(['setDomain'].concat(Array.prototype.slice.call(arguments, 0)));
  }

  if (!utils.validateInput(domain, 'domain', 'string')) {
    return;
  }

  try {
    this.cookieStorage.options({
      expirationDays: this.options.cookieExpiration,
      secure: this.options.secureCookie,
      domain: domain,
      sameSite: this.options.sameSiteCookie
    });
    this.options.domain = this.cookieStorage.options().domain;
    _loadCookieData(this);
    _saveCookieData(this);
  } catch (e) {
    utils.log.error(e);
  }
};

/**
 * Sets an identifier for the current user.
 * @public
 * @param {string} userId - identifier to set. Can be null.
 * @example datadiveClient.setUserId('joe@gmail.com');
 */
DatadiveClient.prototype.setUserId = function setUserId(userId) {
  if (this._shouldDeferCall()) {
    return this._q.push(['setUserId'].concat(Array.prototype.slice.call(arguments, 0)));
  }

  try {
    this.options.userId = (userId !== undefined && userId !== null && ('' + userId)) || null;
    _saveCookieData(this);
  } catch (e) {
    utils.log.error(e);
  }
};

/**
 * Add user to a group or groups. You need to specify a groupType and groupName(s).
 *
 * For example you can group people by their organization.
 * In that case, groupType is "orgId" and groupName would be the actual ID(s).
 * groupName can be a string or an array of strings to indicate a user in multiple gruups.
 * You can also call setGroup multiple times with different groupTypes to track multiple types of groups (up to 5 per app).
 *
 * Note: this will also set groupType: groupName as a user property.
 * See the [advanced topics article](https://developers.amplitude.com/docs/setting-user-groups) for more information.
 * @public
 * @param {string} groupType - the group type (ex: orgId)
 * @param {string|list} groupName - the name of the group (ex: 15), or a list of names of the groups
 * @example datadiveClient.setGroup('orgId', 15); // this adds the current user to orgId 15.
 */
DatadiveClient.prototype.setGroup = function(groupType, groupName) {
  if (this._shouldDeferCall()) {
    return this._q.push(['setGroup'].concat(Array.prototype.slice.call(arguments, 0)));
  }

  if (!this._apiKeySet('setGroup()') || !utils.validateInput(groupType, 'groupType', 'string') ||
        utils.isEmptyString(groupType)) {
    return;
  }

  var groups = {};
  groups[groupType] = groupName;
  var identify = new Identify().set(groupType, groupName);
  this._logEvent(Constants.IDENTIFY_EVENT, null, null, identify.userPropertiesOperations, groups, null, null, null);
};

/**
 * Sets whether to opt current user out of tracking.
 * @public
 * @param {boolean} enable - if true then no events will be logged or sent.
 * @example: datadive.setOptOut(true);
 */
DatadiveClient.prototype.setOptOut = function setOptOut(enable) {
  if (this._shouldDeferCall()) {
    return this._q.push(['setOptOut'].concat(Array.prototype.slice.call(arguments, 0)));
  }

  if (!utils.validateInput(enable, 'enable', 'boolean')) {
    return;
  }

  try {
    this.options.optOut = enable;
    _saveCookieData(this);
  } catch (e) {
    utils.log.error(e);
  }
};

DatadiveClient.prototype.setSessionId = function setSessionId(sessionId) {
  if (!utils.validateInput(sessionId, 'sessionId', 'number')) {
    return;
  }

  try {
    this._sessionId = sessionId;
    _saveCookieData(this);
  } catch (e) {
    utils.log.error(e);
  }
};

DatadiveClient.prototype.resetSessionId = function resetSessionId() {
  this.setSessionId(new Date().getTime());
};

/**
  * Regenerates a new random deviceId for current user. Note: this is not recommended unless you know what you
  * are doing. This can be used in conjunction with `setUserId(null)` to anonymize users after they log out.
  * With a null userId and a completely new deviceId, the current user would appear as a brand new user in dashboard.
  * This uses src/uuid.js to regenerate the deviceId.
  * @public
  */
DatadiveClient.prototype.regenerateDeviceId = function regenerateDeviceId() {
  if (this._shouldDeferCall()) {
    return this._q.push(['regenerateDeviceId'].concat(Array.prototype.slice.call(arguments, 0)));
  }

  this.setDeviceId(base64Id());
};

/**
  * Sets a custom deviceId for current user. Note: this is not recommended unless you know what you are doing
  * (like if you have your own system for managing deviceIds). Make sure the deviceId you set is sufficiently unique
  * (we recommend something like a UUID - see src/uuid.js for an example of how to generate) to prevent conflicts with other devices in our system.
  * @public
  * @param {string} deviceId - custom deviceId for current user.
  * @example datadiveClient.setDeviceId('45f0954f-eb79-4463-ac8a-233a6f45a8f0');
  */
DatadiveClient.prototype.setDeviceId = function setDeviceId(deviceId) {
  if (this._shouldDeferCall()) {
    return this._q.push(['setDeviceId'].concat(Array.prototype.slice.call(arguments, 0)));
  }

  if (!utils.validateInput(deviceId, 'deviceId', 'string')) {
    return;
  }

  try {
    if (!utils.isEmptyString(deviceId)) {
      this.options.deviceId = ('' + deviceId);
      _saveCookieData(this);
    }
  } catch (e) {
    utils.log.error(e);
  }
};

/**
 * Sets user properties for the current user.
 * @public
 * @param {object} - object with string keys and values for the user properties to set.
 * @param {boolean} - DEPRECATED opt_replace: in earlier versions of the JS SDK the user properties object was kept in
 * memory and replace = true would replace the object in memory. Now the properties are no longer stored in memory, so replace is deprecated.
 * @example datadiveClient.setUserProperties({'gender': 'female', 'sign_up_complete': true})
 */
DatadiveClient.prototype.setUserProperties = function setUserProperties(userProperties) {
  if (this._shouldDeferCall()) {
    return this._q.push(['setUserProperties'].concat(Array.prototype.slice.call(arguments, 0)));
  }
  if (!this._apiKeySet('setUserProperties()') || !utils.validateInput(userProperties, 'userProperties', 'object')) {
    return;
  }
  // sanitize the userProperties dict before converting into identify
  var sanitized = utils.truncate(utils.validateProperties(userProperties));
  if (Object.keys(sanitized).length === 0) {
    return;
  }

  // convert userProperties into an identify call
  var identify = new Identify();
  for (var property in sanitized) {
    if (sanitized.hasOwnProperty(property)) {
      identify.set(property, sanitized[property]);
    }
  }
  this.identify(identify);
};

/**
 * Clear all of the user properties for the current user. Note: clearing user properties is irreversible!
 * @public
 * @example datadiveClient.clearUserProperties();
 */
DatadiveClient.prototype.clearUserProperties = function clearUserProperties(){
  if (this._shouldDeferCall()) {
    return this._q.push(['clearUserProperties'].concat(Array.prototype.slice.call(arguments, 0)));
  }

  if (!this._apiKeySet('clearUserProperties()')) {
    return;
  }

  var identify = new Identify();
  identify.clearAll();
  this.identify(identify);
};

/**
 * Applies the proxied functions on the proxied object to an instance of the real object.
 * Used to convert proxied Identify and Revenue objects.
 * @private
 */
var _convertProxyObjectToRealObject = function _convertProxyObjectToRealObject(instance, proxy) {
  for (var i = 0; i < proxy._q.length; i++) {
    var fn = instance[proxy._q[i][0]];
    if (type(fn) === 'function') {
      fn.apply(instance, proxy._q[i].slice(1));
    }
  }
  return instance;
};

/**
 * Send an identify call containing user property operations to Datadive servers.
 * See the [Identify](https://datadive-ai.github.io/dave-JavaScript/Identify/)
 * reference page for more information on the Identify API and user property operations.
 * @param {Identify} identify_obj - the Identify object containing the user property operations to send.
 * @param {Datadive~eventCallback} opt_callback - (optional) callback function to run when the identify event has been sent.
 * Note: the server response code and response body from the identify event upload are passed to the callback function.
 * @example
 * var identify = new datadive.Identify().set('colors', ['rose', 'gold']).add('karma', 1).setOnce('sign_up_date', '2016-03-31');
 * datadive.identify(identify);
 */
DatadiveClient.prototype.identify = function(identify_obj, opt_callback) {
  if (this._shouldDeferCall()) {
    return this._q.push(['identify'].concat(Array.prototype.slice.call(arguments, 0)));
  }
  if (!this._apiKeySet('identify()')) {
    if (type(opt_callback) === 'function') {
      opt_callback(0, 'No request sent', {reason: 'API key is not set'});
    }
    return;
  }

  // if identify input is a proxied object created by the async loading snippet, convert it into an identify object
  if (type(identify_obj) === 'object' && identify_obj.hasOwnProperty('_q')) {
    identify_obj = _convertProxyObjectToRealObject(new Identify(), identify_obj);
  }

  if (identify_obj instanceof Identify) {
    // only send if there are operations
    if (Object.keys(identify_obj.userPropertiesOperations).length > 0) {
      return this._logEvent(
        Constants.IDENTIFY_EVENT, null, null, identify_obj.userPropertiesOperations, null, null, null, opt_callback
        );
    } else {
      if (type(opt_callback) === 'function') {
        opt_callback(0, 'No request sent', {reason: 'No user property operations'});
      }
    }
  } else {
    utils.log.error('Invalid identify input type. Expected Identify object but saw ' + type(identify_obj));
    if (type(opt_callback) === 'function') {
      opt_callback(0, 'No request sent', {reason: 'Invalid identify input type'});
    }
  }
};

DatadiveClient.prototype.groupIdentify = function(group_type, group_name, identify_obj, opt_callback) {
  if (this._shouldDeferCall()) {
    return this._q.push(['groupIdentify'].concat(Array.prototype.slice.call(arguments, 0)));
  }
  if (!this._apiKeySet('groupIdentify()')) {
    if (type(opt_callback) === 'function') {
      opt_callback(0, 'No request sent', {reason: 'API key is not set'});
    }
    return;
  }

  if (!utils.validateInput(group_type, 'group_type', 'string') ||
        utils.isEmptyString(group_type)) {
    if (type(opt_callback) === 'function') {
      opt_callback(0, 'No request sent', {reason: 'Invalid group type'});
    }
    return;
  }

  if (group_name === null || group_name === undefined) {
    if (type(opt_callback) === 'function') {
      opt_callback(0, 'No request sent', {reason: 'Invalid group name'});
    }
    return;
  }

  // if identify input is a proxied object created by the async loading snippet, convert it into an identify object
  if (type(identify_obj) === 'object' && identify_obj.hasOwnProperty('_q')) {
    identify_obj = _convertProxyObjectToRealObject(new Identify(), identify_obj);
  }

  if (identify_obj instanceof Identify) {
    // only send if there are operations
    if (Object.keys(identify_obj.userPropertiesOperations).length > 0) {
      return this._logEvent(
        Constants.GROUP_IDENTIFY_EVENT, null, null, null, {[group_type]: group_name}, identify_obj.userPropertiesOperations, null, opt_callback
        );
    } else {
      if (type(opt_callback) === 'function') {
        opt_callback(0, 'No request sent', {reason: 'No group property operations'});
      }
    }
  } else {
    utils.log.error('Invalid identify input type. Expected Identify object but saw ' + type(identify_obj));
    if (type(opt_callback) === 'function') {
      opt_callback(0, 'No request sent', {reason: 'Invalid identify input type'});
    }
  }
};

/**
 * Set a versionName for your application.
 * @public
 * @param {string} versionName - The version to set for your application.
 * @example datadiveClient.setVersionName('1.12.3');
 */
DatadiveClient.prototype.setVersionName = function setVersionName(versionName) {
  if (this._shouldDeferCall()) {
    return this._q.push(['setVersionName'].concat(Array.prototype.slice.call(arguments, 0)));
  }

  if (!utils.validateInput(versionName, 'versionName', 'string')) {
    return;
  }
  this.options.versionName = versionName;
};

/**
 * Private logEvent method. Keeps apiProperties from being publicly exposed.
 * @private
 */
DatadiveClient.prototype._logEvent = function _logEvent(eventType, eventProperties, apiProperties, userProperties, groups, groupProperties, timestamp, callback) {
  if (!BUILD_COMPAT_REACT_NATIVE) {
    _loadCookieData(this); // reload cookie before each log event to sync event meta-data between windows and tabs
  }
  if (!eventType) {
    if (type(callback) === 'function') {
      callback(0, 'No request sent', {reason: 'Missing eventType'});
    }
    return;
  }
  if (this.options.optOut) {
    if (type(callback) === 'function') {
      callback(0, 'No request sent', {reason: 'optOut is set to true'});
    }
    return;
  }

  try {
    var eventId;
    if (eventType === Constants.IDENTIFY_EVENT || eventType === Constants.GROUP_IDENTIFY_EVENT) {
      eventId = this.nextIdentifyId();
    } else {
      eventId = this.nextEventId();
    }
    var sequenceNumber = this.nextSequenceNumber();
    var eventTime = (type(timestamp) === 'number') ? timestamp : new Date().getTime();
    if (!this._sessionId || !this._lastEventTime || eventTime - this._lastEventTime > this.options.sessionTimeout) {
      this._sessionId = eventTime;
    }
    this._lastEventTime = eventTime;
    _saveCookieData(this);

    let osName = this._ua.browser.name;
    let osVersion = this._ua.browser.major;
    let deviceModel = this._ua.os.name;
    let deviceManufacturer;

    let versionName;
    let carrier;
    if (BUILD_COMPAT_REACT_NATIVE) {
      osName = Platform.OS;
      osVersion = Platform.Version;
      if (this.deviceInfo) {
        carrier = this.deviceInfo.carrier;
        deviceManufacturer = this.deviceInfo.manufacturer;
        deviceModel = this.deviceInfo.model;
        versionName = this.deviceInfo.version;
      }
    }

    userProperties = userProperties || {};
    var trackingOptions = {...this._apiPropertiesTrackingOptions};
    apiProperties = {...(apiProperties || {}), ...trackingOptions};
    eventProperties = eventProperties || {};
    groups = groups || {};
    groupProperties = groupProperties || {};
    var event = {
      device_id: this.options.deviceId,
      user_id: this.options.userId,
      timestamp: eventTime,
      event_id: eventId,
      session_id: this._sessionId || -1,
      event_type: eventType,
      version_name: _shouldTrackField(this, 'version_name') ? (this.options.versionName || versionName || null) : null,
      platform: _shouldTrackField(this, 'platform') ? this.options.platform : null,
      os_name: _shouldTrackField(this, 'os_name') ? (osName || null) : null,
      os_version: _shouldTrackField(this, 'os_version') ? (osVersion || null) : null,
      device_model: _shouldTrackField(this, 'device_model') ? (deviceModel || null) : null,
      device_manufacturer: _shouldTrackField(this, 'device_manufacturer') ? (deviceManufacturer || null) : null,
      language: _shouldTrackField(this, 'language') ? this.options.language : null,
      carrier: _shouldTrackField(this, 'carrier') ? (carrier || null): null,
      api_properties: apiProperties,
      event_properties: utils.truncate(utils.validateProperties(eventProperties)),
      user_properties: utils.truncate(utils.validateProperties(userProperties)),
      ...this._getParamsAndReferrer(eventType),
      ...this._getUrl(eventType),
      uuid: UUID(),
      library: {
        name: BUILD_COMPAT_REACT_NATIVE ? 'datadive-react-native' : 'datadive-js',
        version: version
      },
      sequence_number: sequenceNumber, // for ordering events and identifys
      groups: utils.truncate(utils.validateGroups(groups)),
      group_properties: utils.truncate(utils.validateProperties(groupProperties)),
      user_agent: this._userAgent
    };

    if (eventType === Constants.IDENTIFY_EVENT || eventType === Constants.GROUP_IDENTIFY_EVENT) {
      this._unsentIdentifys.push({event, callback});
      this._limitEventsQueued(this._unsentIdentifys);
    } else {
      this._unsentEvents.push({event, callback});
      this._limitEventsQueued(this._unsentEvents);
    }

    if (this.options.saveEvents) {
      this.saveEvents();
    }

    this._sendEventsIfReady(callback);

    return eventId;
  } catch (e) {
    utils.log.error(e);
  }
};

var _shouldTrackField = function _shouldTrackField(scope, field) {
  return !!scope.options.trackingOptions[field];
};

var _generateApiPropertiesTrackingConfig = function _generateApiPropertiesTrackingConfig(scope) {
  // to limit size of config payload, only send fields that have been disabled
  var fields = ['city', 'country', 'dma', 'ip_address', 'region'];
  var config = {};
  for (var i = 0; i < fields.length; i++) {
    var field = fields[i];
    if (!_shouldTrackField(scope, field)) {
      config[field] = false;
    }
  }
  return config;
};

/**
 * Remove old events from the beginning of the array if too many have accumulated. Default limit is 1000 events.
 * @private
 */
DatadiveClient.prototype._limitEventsQueued = function _limitEventsQueued(queue) {
  if (queue.length > this.options.savedMaxCount) {
    queue.splice(0, queue.length - this.options.savedMaxCount);
  }
};

/**
 * This is the callback for logEvent and identify calls. It gets called after the event/identify is uploaded,
 * and the server response code and response body from the upload request are passed to the callback function.
 * @callback Datadive~eventCallback
 * @param {number} responseCode - Server response code for the event / identify upload request.
 * @param {string} responseBody - Server response body for the event / identify upload request.
 */

/**
 * Log an event with eventType and eventProperties
 * @public
 * @param {string} eventType - name of event
 * @param {object} eventProperties - (optional) an object with string keys and values for the event properties.
 * @param {Datadive~eventCallback} opt_callback - (optional) a callback function to run after the event is logged.
 * Note: the server response code and response body from the event upload are passed to the callback function.
 * @example datadiveClient.logEvent('Clicked Homepage Button', {'finished_flow': false, 'clicks': 15});
 */
DatadiveClient.prototype.logEvent = function logEvent(eventType, eventProperties, opt_callback) {
  if (this._shouldDeferCall()) {
    return this._q.push(['logEvent'].concat(Array.prototype.slice.call(arguments, 0)));
  }
  return this.logEventWithTimestamp(eventType, eventProperties, null, opt_callback);
};

/**
 * Log an event with eventType and eventProperties and a custom timestamp
 * @public
 * @param {string} eventType - name of event
 * @param {object} eventProperties - (optional) an object with string keys and values for the event properties.
 * @param {number} timestamp - (optional) the custom timestamp as milliseconds since epoch.
 * @param {Datadive~eventCallback} opt_callback - (optional) a callback function to run after the event is logged.
 * Note: the server response code and response body from the event upload are passed to the callback function.
 * @example datadiveClient.logEvent('Clicked Homepage Button', {'finished_flow': false, 'clicks': 15});
 */
DatadiveClient.prototype.logEventWithTimestamp = function logEvent(eventType, eventProperties, timestamp, opt_callback) {
  if (this._shouldDeferCall()) {
    return this._q.push(['logEventWithTimestamp'].concat(Array.prototype.slice.call(arguments, 0)));
  }
  if (!this._apiKeySet('logEvent()')) {
    if (type(opt_callback) === 'function') {
      opt_callback(0, 'No request sent', {reason: 'API key not set'});
    }
    return -1;
  }
  if (!utils.validateInput(eventType, 'eventType', 'string')) {
    if (type(opt_callback) === 'function') {
      opt_callback(0, 'No request sent', {reason: 'Invalid type for eventType'});
    }
    return -1;
  }
  if (utils.isEmptyString(eventType)) {
    if (type(opt_callback) === 'function') {
      opt_callback(0, 'No request sent', {reason: 'Missing eventType'});
    }
    return -1;
  }
  return this._logEvent(eventType, eventProperties, null, null, null, null, timestamp, opt_callback);
};

/**
 * Log an event with eventType, eventProperties, and groups. Use this to set event-level groups.
 * Note: the group(s) set only apply for the specific event type being logged and does not persist on the user
 * (unless you explicitly set it with setGroup).
 *
 * See the [advanced topics article](https://developers.amplitude.com/docs/setting-user-groups) for more information.
 * about groups and Count by Distinct on the Datadive platform.
 * @public
 * @param {string} eventType - name of event
 * @param {object} eventProperties - (optional) an object with string keys and values for the event properties.
 * @param {object} groups - (optional) an object with string groupType: groupName values for the event being logged.
 * groupName can be a string or an array of strings.
 * @param {Datadive~eventCallback} opt_callback - (optional) a callback function to run after the event is logged.
 * Note: the server response code and response body from the event upload are passed to the callback function.
 * @example datadiveClient.logEventWithGroups('Clicked Button', null, {'orgId': 24});
 */
DatadiveClient.prototype.logEventWithGroups = function(eventType, eventProperties, groups, opt_callback) {
  if (this._shouldDeferCall()) {
    return this._q.push(['logEventWithGroups'].concat(Array.prototype.slice.call(arguments, 0)));
  }
  if (!this._apiKeySet('logEventWithGroups()')) {
    if (type(opt_callback) === 'function') {
      opt_callback(0, 'No request sent', {reason: 'API key not set'});
    }
    return -1;
  }
  if (!utils.validateInput(eventType, 'eventType', 'string')) {
    if (type(opt_callback) === 'function') {
      opt_callback(0, 'No request sent', {reason: 'Invalid type for eventType'});
    }
    return -1;
  }
  return this._logEvent(eventType, eventProperties, null, null, groups, null, null, opt_callback);
};

/**
 * Test that n is a number or a numeric value.
 * @private
 */
var _isNumber = function _isNumber(n) {
  return !isNaN(parseFloat(n)) && isFinite(n);
};

/**
 * Log revenue with Revenue interface. The new revenue interface allows for more revenue fields like
 * revenueType and event properties.
 *
 * See the [Revenue](https://datadive-ai.github.io/dave-JavaScript/Revenue/)
 * reference page for more information on the Revenue interface and logging revenue.
 * @public
 * @param {Revenue} revenue_obj - the revenue object containing the revenue data being logged.
 * @example var revenue = new datadive.Revenue().setProductId('productIdentifier').setPrice(10.99);
 * datadive.logRevenueV2(revenue);
 */
DatadiveClient.prototype.logRevenueV2 = function logRevenueV2(revenue_obj) {
  if (this._shouldDeferCall()) {
    return this._q.push(['logRevenueV2'].concat(Array.prototype.slice.call(arguments, 0)));
  }

  if (!this._apiKeySet('logRevenueV2()')) {
    return;
  }

  // if revenue input is a proxied object created by the async loading snippet, convert it into an revenue object
  if (type(revenue_obj) === 'object' && revenue_obj.hasOwnProperty('_q')) {
    revenue_obj = _convertProxyObjectToRealObject(new Revenue(), revenue_obj);
  }

  if (revenue_obj instanceof Revenue) {
    // only send if revenue is valid
    if (revenue_obj && revenue_obj._isValidRevenue()) {
      return this.logEvent(Constants.REVENUE_EVENT, revenue_obj._toJSONObject());
    }
  } else {
    utils.log.error('Invalid revenue input type. Expected Revenue object but saw ' + type(revenue_obj));
  }
};

if (BUILD_COMPAT_2_0) {
  /**
   * Log revenue event with a price, quantity, and product identifier. DEPRECATED - use logRevenueV2
   * @public
   * @deprecated
   * @param {number} price - price of revenue event
   * @param {number} quantity - (optional) quantity of products in revenue event. If no quantity specified default to 1.
   * @param {string} product - (optional) product identifier
   * @example datadiveClient.logRevenue(3.99, 1, 'product_1234');
   */
  DatadiveClient.prototype.logRevenue = function logRevenue(price, quantity, product) {
    if (this._shouldDeferCall()) {
      return this._q.push(['logRevenue'].concat(Array.prototype.slice.call(arguments, 0)));
    }

    // Test that the parameters are of the right type.
    if (!this._apiKeySet('logRevenue()') || !_isNumber(price) || (quantity !== undefined && !_isNumber(quantity))) {
      // utils.log('Price and quantity arguments to logRevenue must be numbers');
      return -1;
    }

    return this._logEvent(Constants.REVENUE_EVENT, {}, {
      productId: product,
      special: 'revenue_amount',
      quantity: quantity || 1,
      price: price
    }, null, null, null, null, null);
  };
}

/**
 * Remove events in storage with event ids up to and including maxEventId.
 * @private
 */
DatadiveClient.prototype.removeEvents = function removeEvents(maxEventId, maxIdentifyId, status, response) {
  _removeEvents(this, '_unsentEvents', maxEventId, status, response);
  _removeEvents(this, '_unsentIdentifys', maxIdentifyId, status, response);
};

/**
 * Helper function to remove events up to maxId from a single queue.
 * Does a true filter in case events get out of order or old events are removed.
 * @private
 */
var _removeEvents = function _removeEvents(scope, eventQueue, maxId, status, response) {
  if (maxId < 0) {
    return;
  }

  var filteredEvents = [];
  for (var i = 0; i < scope[eventQueue].length || 0; i++) {
    const unsentEvent = scope[eventQueue][i];

    if (unsentEvent.event.event_id > maxId) {
      filteredEvents.push(unsentEvent);
    } else {
      if (unsentEvent.callback) {
        unsentEvent.callback(status, response);
      }
    }
  }
  scope[eventQueue] = filteredEvents;
};

/**
 * Send unsent events. Note: this is called automatically after events are logged if option batchEvents is false.
 * If batchEvents is true, then events are only sent when batch criterias are met.
 * @private
 */
DatadiveClient.prototype.sendEvents = function sendEvents() {
  if (!this._apiKeySet('sendEvents()')) {
    this.removeEvents(Infinity, Infinity, 0, 'No request sent', {reason: 'API key not set'});
    return;
  }

  if (this.options.optOut) {
    this.removeEvents(Infinity, Infinity, 0, 'No request sent', {reason: 'Opt out is set to true'});
    return;
  }

  // How is it possible to get into this state?
  if (this._unsentCount() === 0) {
    return;
  }

  // We only make one request at a time. sendEvents will be invoked again once
  // the last request completes.
  if (this._sending) {
    return;
  }

  this._sending = true;
  var protocol = this.options.forceHttps ? 'https' : ('https:' === window.location.protocol ? 'https' : 'http');
  var url = protocol + '://' + this.options.apiEndpoint;

  // fetch events to send
  var numEvents = Math.min(this._unsentCount(), this.options.uploadBatchSize);
  var mergedEvents = this._mergeEventsAndIdentifys(numEvents);
  var maxEventId = mergedEvents.maxEventId;
  var maxIdentifyId = mergedEvents.maxIdentifyId;
  var events = JSON.stringify(mergedEvents.eventsToSend.map(({event}) => event));
  var uploadTime = new Date().getTime();

  var data = {
    client: this.options.apiKey,
    e: events,
    v: Constants.API_VERSION,
    upload_time: uploadTime,
    checksum: md5(Constants.API_VERSION + this.options.apiKey + events + uploadTime)
  };

  var scope = this;
  new Request(url, data).send(function(status, response) {
    scope._sending = false;
    try {
      if (status === 200 && response === 'success') {
        scope.removeEvents(maxEventId, maxIdentifyId, status, response);

        // Update the event cache after the removal of sent events.
        if (scope.options.saveEvents) {
          scope.saveEvents();
        }

        // Send more events if any queued during previous send.
        scope._sendEventsIfReady();

      // handle payload too large
      } else if (status === 413) {
        // utils.log('request too large');
        // Can't even get this one massive event through. Drop it, even if it is an identify.
        if (scope.options.uploadBatchSize === 1) {
          scope.removeEvents(maxEventId, maxIdentifyId, status, response);
        }

        // The server complained about the length of the request. Backoff and try again.
        scope.options.uploadBatchSize = Math.ceil(numEvents / 2);
        scope.sendEvents();

      }
      // else {
      //  all the events are still queued, and will be retried when the next
      //  event is sent In the interest of debugging, it would be nice to have
      //  something like an event emitter for a better debugging experince
      //  here.
      // }
    } catch (e) {
      // utils.log('failed upload');
    }
  });
};

/**
 * Merge unsent events and identifys together in sequential order based on their sequence number, for uploading.
 * Identifys given higher priority than Events. Also earlier sequence given priority
 * @private
 */
DatadiveClient.prototype._mergeEventsAndIdentifys = function _mergeEventsAndIdentifys(numEvents) {
  // coalesce events from both queues
  var eventsToSend = [];
  var eventIndex = 0;
  var maxEventId = -1;
  var identifyIndex = 0;
  var maxIdentifyId = -1;

  while (eventsToSend.length < numEvents) {
    let unsentEvent;
    let noIdentifys = identifyIndex >= this._unsentIdentifys.length;
    let noEvents = eventIndex >= this._unsentEvents.length;

    // case 0: no events or identifys left
    // note this should not happen, this means we have less events and identifys than expected
    if (noEvents && noIdentifys) {
      utils.log.error('Merging Events and Identifys, less events and identifys than expected');
      break;
    }

    // case 1: no identifys - grab from events
    else if (noIdentifys) {
      unsentEvent = this._unsentEvents[eventIndex++];
      maxEventId = unsentEvent.event.event_id;

    // case 2: no events - grab from identifys
    } else if (noEvents) {
      unsentEvent = this._unsentIdentifys[identifyIndex++];
      maxIdentifyId = unsentEvent.event.event_id;

    // case 3: need to compare sequence numbers
    } else {
      // events logged before v2.5.0 won't have a sequence number, put those first
      if (!('sequence_number' in this._unsentEvents[eventIndex].event) ||
          this._unsentEvents[eventIndex].event.sequence_number <
          this._unsentIdentifys[identifyIndex].event.sequence_number) {
        unsentEvent = this._unsentEvents[eventIndex++];
        maxEventId = unsentEvent.event.event_id;
      } else {
        unsentEvent = this._unsentIdentifys[identifyIndex++];
        maxIdentifyId = unsentEvent.event.event_id;
      }
    }

    eventsToSend.push(unsentEvent);
  }

  return {
    eventsToSend: eventsToSend,
    maxEventId: maxEventId,
    maxIdentifyId: maxIdentifyId
  };
};

if (BUILD_COMPAT_2_0) {
  /**
   * Set global user properties. Note this is deprecated, and we recommend using setUserProperties
   * @public
   * @deprecated
   */
  DatadiveClient.prototype.setGlobalUserProperties = function setGlobalUserProperties(userProperties) {
    this.setUserProperties(userProperties);
  };
}

/**
 * Get the current version of Datadive's Javascript SDK.
 * @public
 * @returns {number} version number
 * @example var datadiveVersion = datadive.__VERSION__;
 */
DatadiveClient.prototype.__VERSION__ = version;

/**
 * Determines whether or not to push call to this._q or invoke it
 * @private
 */
DatadiveClient.prototype._shouldDeferCall = function _shouldDeferCall() {
  return this._pendingReadStorage || this._initializationDeferred;
};

/**
 * Defers Initialization by putting all functions into storage until users
 * have accepted terms for tracking
 * @private
 */
DatadiveClient.prototype._deferInitialization = function _deferInitialization() {
  this._initializationDeferred = true;
  this._q.push(['init'].concat(Array.prototype.slice.call(arguments, 0)));
};

/**
 * Enable tracking via logging events and dropping a cookie
 * Intended to be used with the deferInitialization configuration flag
 * This will drop a cookie and reset initialization deferred
 * @public
 */
DatadiveClient.prototype.enableTracking = function enableTracking() {
  // This will call init (which drops the cookie) and will run any pending tasks
  this._initializationDeferred = false;
  _saveCookieData(this);
  this.runQueuedFunctions();
};

export default DatadiveClient;