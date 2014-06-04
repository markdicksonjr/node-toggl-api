'use strict'

var _ = require('lodash')
  , errors = require('./errors')
  , EventEmitter = require('events').EventEmitter
  , request = require('request')
  , APIError = errors.APIError

var defaults = {
  reauth:        false,
  sessionCookie: 'toggl_api_session',
  url:           'https://www.toggl.com'
}



function noop() {
}




/**
 * Validate client options
 */
function validateOptions(options) {
  if (!options.apiToken && !(options.username && options.password)) {
    throw new Error('You should either specify apiToken or username and password')
  }

  // if we use apiToken we do not need a session cookie
  if (options.apiToken) {
    options.reauth = true
  }

  if (!options.url) {
    throw new Error('Toggl API base URL is not specified')
  }
}




/**
 * Expose client
 */
module.exports = TogglClient




/**
 * API wrapper
 *
 * @constructor
 * @param options Client options
 */
function TogglClient(options) {
  /**
   * @private
   */
  this.options = {}
  _.assign(this.options, defaults)
  _.assign(this.options, options)

  validateOptions(this.options)


  /**
   * For internal needs
   *
   * @private
   * @type {EventEmitter}
   */
  this.emitter = new EventEmitter()
  this.emitter.setMaxListeners(0)


  /**
   * Used to store and set cookies for API requests
   *
   * @private
   * @type {CookieJar}
   */
  this.cookieJar = request.jar()


  /**
   * Result of authentication call
   *
   * @public
   */
  this.authData = null


  /**
   * Re-authentication timeout ID
   *
   * @private
   */
  this.authTimeout = null


  /**
   * If we're authenticating
   *
   * @private
   */
  this.authenticating = false
}




/**
 * Make authentication call only if you use username & password
 *
 * @public
 * @param {function} [callback] Accepts arguments: (err, userData)
 */
TogglClient.prototype.authenticate = function(callback) {
  var self = this
    , options = this.options
    , auth
    , req = {}

  callback = callback || noop

  if (options.username && options.password) {
    auth = {
      user: options.username,
      pass: options.password
    }
  }
  else {
    return callback(new Error('No need to authenticate thus you use apiToken'))
  }

  req.auth = auth
  req.method = 'GET'

  this.apiRequest('/api/v8/me', req, done)
  this.authenticating = true

  function done(err, data) {
    self.emitter.emit('authenticate', err, data)

    if (err) {
      return error(err)
    }

    self.authData = data

    if (options.reauth) {
      self.cookieJar._jar.getCookies(options.url, oncookies)
    }
    else {
      success()
    }
  }

  function oncookies(err, cookies) {
    if (err) {
      error(err)
    }

    var sessionCookie = _.find(cookies, {key: options.sessionCookie})
      , ttl = sessionCookie.ttl()

    if (ttl) {
      self.setAuthTimer(ttl)
    }

    success()
  }

  function success() {
    self.authenticating = false
    self.emitter.emit('authenticate', null, self.authData)

    callback(null, self.authData)
  }

  function error(err) {
    self.authenticating = false
    self.emitter.emit('authenticate', err)

    callback(err)
  }
}




/**
 * Request to Toggl API v8
 *
 * @private
 * @param {string} path API path
 * @param {object} opts Request options
 * @param {function} callback Accepts arguments: (err, data)
 */
TogglClient.prototype.apiRequest = function(path, opts, callback) {
  var self = this
    , options = this.options

  if (this.authenticating) {
    this.emitter.on('authenticate', function(err) {
      if (err) {
        return callback(err)
      }

      self.apiRequest(path, opts, callback)
    })

    return
  }

  if (options.apiToken) {
    opts.auth = {
      user: options.apiToken,
      pass: 'api_token'
    }
  }

  opts.url = options.url + path
  opts.json = true
  opts.jar = this.cookieJar

  request(opts, onresponse)

  function onresponse(err, response, data) {
    var statusCode = response.statusCode

    if (err) {
      callback(err)
    }
    else if (statusCode >= 200 && statusCode < 300) {
      callback(null, data)
    }
    else {
      return callback(new APIError(statusCode, data))
    }
  }
}




/**
 * Set timer for re-authentication
 *
 * @private
 * @param {number} duration
 */
TogglClient.prototype.setAuthTimer = function(duration) {
  var self = this

  // run re-auth before current session actually expires
  duration -= 5000

  this.authTimeout = setTimeout(reauth, duration)

  function reauth() {
    self.authTimeout = null
    self.authenticate()
  }
}




/**
 * Call when client is no longer needed
 *
 * @public
 */
TogglClient.prototype.destroy = function() {
  if (this.authTimeout) {
    clearTimeout(this.authTimeout)
  }
}