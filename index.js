module.exports = SteamTradeOffers;

var request = require('request');
var cheerio = require('cheerio');
var Long = require('long');
var url = require('url');
var querystring = require('querystring');

require('util').inherits(SteamTradeOffers, require('events').EventEmitter);

function SteamTradeOffers() {
  require('events').EventEmitter.call(this);

  this._j = request.jar();
  this._request = request.defaults({ jar: this._j });
}

SteamTradeOffers.prototype.setup = function(options, callback) {
  this.sessionID = options.sessionID;

  options.webCookie.forEach(function(name) {
    setCookie.bind(this)(name);
  }.bind(this));

  getAPIKey.bind(this)(callback);
};

function getAPIKey(callback) {
  if (this.APIKey) {
    if (typeof callback == 'function') {
      callback();
    }
    return;
  }
  this._request.get({
    uri: 'https://steamcommunity.com/dev/apikey'
  }, function(error, response, body) {
    if (error || response.statusCode != 200) {
      this.emit('debug', 'retrieving apikey: ' + (error || response.statusCode));
      if (typeof callback == 'function') {
        callback(error || response.statusCode);
      }
    } else {
      var $ = cheerio.load(body);
      if ($('#mainContents h2').html() == 'Access Denied') {
        this.emit('debug', 'retrieving apikey: access denied (probably limited account)');
        this.APIKey = '';
        var accessError = new Error('Access Denied');
        if (typeof callback == 'function') {
          callback(accessError);
        } else {
          throw accessError;
        }
      } else if ($('#bodyContents_ex h2').html() == 'Your Steam Web API Key') {
        var key = $('#bodyContents_ex p').html().split(' ')[1];
        this.APIKey = key;
        if (typeof callback == 'function') {
          callback();
        }
      } else {
        this._request.post({
          uri: 'https://steamcommunity.com/dev/registerkey',
          form: {
            domain: 'localhost',
            agreeToTerms: 1
          }
        }, function(error, response, body) {
          getAPIKey.bind(this)(callback);
        }.bind(this));
      }
    }
  }.bind(this));
}

SteamTradeOffers.prototype.getOfferToken = function(callback) {
  this._request.get({
    uri: 'https://steamcommunity.com/id/me/tradeoffers/privacy'
  }, function(error, response, body) {
    if (error || response.statusCode != 200) {
      this.emit('debug', 'retrieving offer token: ' + (error || response.statusCode));

      callback(new Error(error || response.statusCode));
    } else {
      var $ = cheerio.load(body);

      var offerUrl = $('input#trade_offer_access_url').val();
      var offerToken = url.parse(offerUrl, true).query.token;

      callback(null, offerToken);
    }
  }.bind(this));
};

function setCookie(cookie) {
  this._j.setCookie(request.cookie(cookie), 'https://steamcommunity.com');
}

SteamTradeOffers.prototype._loadInventory = function(inventory, uri, options, contextid, start, callback) {
  options.uri = uri;
  
  if (start) {
    options.uri = options.uri + '&' + querystring.stringify({ 'start': start });
  }

  this._request.get(options, function(error, response, body) {
    if (error || response.statusCode != 200 || JSON.stringify(body) == '{}') {
      this.emit('debug', 'loading inventory: ' + (error || (response.statusCode != 200 ? response.statusCode : '{}')));
      callback(new Error(error || (response.statusCode != 200 ? response.statusCode : 'Blank response')));
    } else if (typeof body != 'object') {
      // no session
      callback(new Error('No session'));
    } else if (body.success === false) {
      // inventory not found
      callback(new Error('Inventory not found'));
    } else if (Object.prototype.toString.apply(body) == '[object Array]') {
      //private inventory
      callback(new Error('Inventory is private'));
    } else {
      inventory = inventory.concat(mergeWithDescriptions(body.rgInventory, body.rgDescriptions, contextid)
        .concat(mergeWithDescriptions(body.rgCurrency, body.rgDescriptions, contextid)));
      if (body.more) {
        this._loadInventory(inventory, uri, options, contextid, body.more_start, callback);
      } else {
        callback(null, inventory);
      }
    }
  }.bind(this));
};

SteamTradeOffers.prototype.loadMyInventory = function(options, callback) {
  var query = {};

  if (options.language) {
    query.l = options.language;
  }

  if (options.tradableOnly !== false) {
    query.trading = 1;
  }

  var uri = 'https://steamcommunity.com/my/inventory/json/' + options.appId + '/' + options.contextId + '/?' + querystring.stringify(query);

  this._loadInventory([], uri, { json: true }, options.contextId, null, callback);
};

SteamTradeOffers.prototype.loadPartnerInventory = function(options, callback) {
  var form = {
    sessionid: this.sessionID,
    partner: options.partnerSteamId,
    appid: options.appId,
    contextid: options.contextId
  };

  if (options.language) {
    form.l = options.language;
  }

  var offer = 'new';
  if (options.tradeOfferId) {
    offer = options.tradeOfferId;
  }

  var uri = 'https://steamcommunity.com/tradeoffer/' + offer + '/partnerinventory/?' + querystring.stringify(form);

  this._loadInventory([], uri, {
    json: true,
    headers: {
      referer: 'https://steamcommunity.com/tradeoffer/' + offer + '/?partner=' + toAccountId(options.partnerSteamId)
    }
  }, options.contextId, null, callback);
};

function mergeWithDescriptions(items, descriptions, contextid) {
  return Object.keys(items).map(function(id) {
    var item = items[id];
    var description = descriptions[item.classid + '_' + (item.instanceid || '0')];
    for (var key in description) {
      item[key] = description[key];
    }
    // add contextid because Steam is retarded
    item.contextid = contextid;
    return item;
  });
}

function doAPICall(options) {
  var params = {
    uri: 'https://api.steampowered.com/IEconService/' + options.method + '/?key=' + this.APIKey + ((options.post) ? '' : '&' + querystring.stringify(options.params)),
    json: true,
    method: options.post ? 'POST' : 'GET'
  };

  if (options.post) {
    params.form = options.params;
  }

  request(params, function(error, response, body) {
    if (error || response.statusCode != 200) {
      this.emit('debug', 'doing API call ' + options.method + ': ' + (error || response.statusCode));
      if (typeof options.callback == 'function') {
        options.callback(error || new Error(response.statusCode));
      }
    } else if (typeof body != 'object') {
      if (typeof options.callback == 'function') {
        options.callback(new Error('Invalid response'));
      }
    } else {
      if (typeof options.callback == 'function') {
        options.callback(null, body);
      }
    }
  }.bind(this));
}

SteamTradeOffers.prototype.getOffers = function(options, callback) {
  doAPICall.bind(this)({
    method: 'GetTradeOffers/v1',
    params: options,
    callback: function(error, res) {
      if (error) {
        callback(error);
      } else {
        if (res.response.trade_offers_received !== undefined) {
          res.response.trade_offers_received = res.response.trade_offers_received.map(function(offer) {
            offer.steamid_other = toSteamId(offer.accountid_other);
            return offer;
          });
        }
        if (res.response.trade_offers_sent !== undefined) {
          res.response.trade_offers_sent = res.response.trade_offers_sent.map(function(offer) {
            offer.steamid_other = toSteamId(offer.accountid_other);
            return offer;
          });
        }
        callback(null, res);
      }
    }
  });
};

SteamTradeOffers.prototype.getOffer = function(options, callback) {
  doAPICall.bind(this)({
    method: 'GetTradeOffer/v1',
    params: options,
    callback: function(error, res) {
      if (error) {
        callback(error);
      } else {
        if (res.response.offer !== undefined) {
          res.response.offer.steamid_other = toSteamId(res.response.offer.accountid_other);
        }
        callback(null, res);
      }
    }
  });
};

SteamTradeOffers.prototype.declineOffer = function(options, callback) {
  doAPICall.bind(this)({method: 'DeclineTradeOffer/v1', params: {tradeofferid: options.tradeOfferId}, post: true, callback: callback});
};

SteamTradeOffers.prototype.cancelOffer = function(options, callback) {
  doAPICall.bind(this)({method: 'CancelTradeOffer/v1', params: {tradeofferid: options.tradeOfferId}, post: true, callback: callback});
};

SteamTradeOffers.prototype.acceptOffer = function(options, callback) {
  if (options.tradeOfferId === undefined) {
    if (typeof callback == 'function') {
      callback(new Error('No options'));
    }
  } else {
    this._request.post({
      uri: 'https://steamcommunity.com/tradeoffer/' + options.tradeOfferId + '/accept',
      headers: {
        referer: 'https://steamcommunity.com/tradeoffer/' + options.tradeOfferId + '/'
      },
      form: {
        sessionid: this.sessionID,
        serverid: 1,
        tradeofferid: options.tradeOfferId
      }
    }, function(error, response, body) {
      var result = {};
      try {
        result = JSON.parse(body) || {};
      } catch(e) {
        if (typeof callback == 'function') {
          return callback(e);
        }
      }

      if (error || response.statusCode != 200) {
        this.emit('debug', 'accepting offer: ' + (error || response.statusCode));
        if (typeof callback == 'function') {
          callback(error || new Error(result.strError || response.statusCode));
        }
      } else {
        if (typeof callback == 'function') {
          callback(null, result);
        }
      }
    }.bind(this));
  }
};

function toSteamId(accountId) {
  return new Long(parseInt(accountId, 10), 0x1100001).toString();
}

function toAccountId(steamId) {
  return Long.fromString(steamId).toInt().toString();
}

SteamTradeOffers.prototype.makeOffer = function(options, callback) {
  var tradeoffer = {
    newversion: true,
    version: 2,
    me: { assets: options.itemsFromMe, currency: [], ready: false },
    them: { assets: options.itemsFromThem, currency: [], ready: false }
  };

  var formFields = {
    serverid: 1,
    sessionid: this.sessionID,
    partner: options.partnerSteamId || toSteamId(options.partnerAccountId),
    tradeoffermessage: options.message || '',
    json_tradeoffer: JSON.stringify(tradeoffer)
  };

  var query = {
    partner: options.partnerAccountId || toAccountId(options.partnerSteamId)
  };

  if (options.accessToken !== undefined) {
    formFields.trade_offer_create_params = JSON.stringify({ trade_offer_access_token: options.accessToken });
    query.token = options.accessToken;
  }
  
  var referer;
  if (options.counteredTradeOffer !== undefined) {
    formFields.tradeofferid_countered = options.counteredTradeOffer;
    referer = 'https://steamcommunity.com/tradeoffer/' + options.counteredTradeOffer + '/';
  } else {
    referer = 'https://steamcommunity.com/tradeoffer/new/?' + querystring.stringify(query);
  }

  this._request.post({
    uri: 'https://steamcommunity.com/tradeoffer/new/send',
    headers: {
      referer: referer
    },
    form: formFields
  }, function(error, response, body) {
    var result = {};
    try {
      result = JSON.parse(body) || {};
    } catch(e) {
      if (typeof callback == 'function') {
        return callback(e);
      }
    }

    if (error || response.statusCode != 200) {
      this.emit('debug', 'making an offer: ' + (error || response.statusCode));
      if (typeof callback == 'function') {
        callback(error || new Error(result.strError || response.statusCode));
      }
    } else {
      if (typeof callback == 'function') {
        callback(null, result);
      }
    }
  }.bind(this));
};
