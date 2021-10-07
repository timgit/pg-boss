'use strict';

var _createClass = function () { function defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ("value" in descriptor) descriptor.writable = true; Object.defineProperty(target, descriptor.key, descriptor); } } return function (Constructor, protoProps, staticProps) { if (protoProps) defineProperties(Constructor.prototype, protoProps); if (staticProps) defineProperties(Constructor, staticProps); return Constructor; }; }();

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

function _possibleConstructorReturn(self, call) { if (!self) { throw new ReferenceError("this hasn't been initialised - super() hasn't been called"); } return call && (typeof call === "object" || typeof call === "function") ? call : self; }

function _inherits(subClass, superClass) { if (typeof superClass !== "function" && superClass !== null) { throw new TypeError("Super expression must either be null or a function, not " + typeof superClass); } subClass.prototype = Object.create(superClass && superClass.prototype, { constructor: { value: subClass, enumerable: false, writable: true, configurable: true } }); if (superClass) Object.setPrototypeOf ? Object.setPrototypeOf(subClass, superClass) : subClass.__proto__ = superClass; }

var EventEmitter = require('events').EventEmitter; //node 0.10 compatibility;
var assert = require('assert');

var Attorney = require('./attorney');
var Contractor = require('./contractor');
var Manager = require('./manager');
var Boss = require('./boss');

var notReadyErrorMessage = 'boss ain\'t ready.  Use start() or connect() to get started.';

var PgBoss = function (_EventEmitter) {
    _inherits(PgBoss, _EventEmitter);

    _createClass(PgBoss, null, [{
        key: 'getConstructionPlans',
        value: function getConstructionPlans(schema) {
            return Contractor.constructionPlans(schema);
        }
    }, {
        key: 'getMigrationPlans',
        value: function getMigrationPlans(schema, version, uninstall) {
            return Contractor.migrationPlans(schema, version, uninstall);
        }
    }]);

    function PgBoss(config) {
        _classCallCheck(this, PgBoss);

        config = Attorney.checkConfig(config);

        var _this = _possibleConstructorReturn(this, (PgBoss.__proto__ || Object.getPrototypeOf(PgBoss)).call(this));

        _this.config = config;

        // contractor makes sure we have a happy database home for work
        _this.contractor = new Contractor(config);

        // boss keeps the books and archives old jobs
        var boss = new Boss(config);
        _this.boss = boss;
        boss.on('error', function (error) {
            return _this.emit('error', error);
        });
        boss.on('archived', function (count) {
            return _this.emit('archived', count);
        });

        // manager makes sure workers aren't taking too long to finish their jobs
        var manager = new Manager(config);
        _this.manager = manager;
        manager.on('error', function (error) {
            return _this.emit('error', error);
        });
        manager.on('job', function (job) {
            return _this.emit('job', job);
        });
        manager.on('expired', function (count) {
            return _this.emit('expired', count);
        });
        return _this;
    }

    _createClass(PgBoss, [{
        key: 'init',
        value: function init() {
            var _this2 = this;

            if (!this.isReady) {
                return this.boss.supervise().then(function () {
                    return _this2.manager.monitor();
                }).then(function () {
                    _this2.isReady = true;
                    return _this2;
                });
            } else return Promise.resolve(this);
        }
    }, {
        key: 'start',
        value: function start() {
            var self = this;

            if (this.isStarting) return Promise.reject('boss is starting up. Please wait for the previous start() to finish.');

            this.isStarting = true;

            return this.contractor.start.apply(this.contractor, arguments).then(function () {
                self.isStarting = false;
                return self.init();
            });
        }
    }, {
        key: 'stop',
        value: function stop() {
            return Promise.all([this.disconnect(), this.manager.stop(), this.boss.stop()]);
        }
    }, {
        key: 'connect',
        value: function connect() {
            var self = this;

            return this.contractor.connect.apply(this.contractor, arguments).then(function () {
                self.isReady = true;
                return self;
            });
        }
    }, {
        key: 'disconnect',
        value: function disconnect() {
            var self = this;

            if (!this.isReady) return Promise.reject(notReadyErrorMessage);
            return this.manager.close.apply(this.manager, arguments).then(function () {
                return self.isReady = false;
            });
        }
    }, {
        key: 'cancel',
        value: function cancel() {
            if (!this.isReady) return Promise.reject(notReadyErrorMessage);
            return this.manager.cancel.apply(this.manager, arguments);
        }
    }, {
        key: 'subscribe',
        value: function subscribe() {
            if (!this.isReady) return Promise.reject(notReadyErrorMessage);
            return this.manager.subscribe.apply(this.manager, arguments);
        }
    }, {
        key: 'publish',
        value: function publish() {
            if (!this.isReady) return Promise.reject(notReadyErrorMessage);
            return this.manager.publish.apply(this.manager, arguments);
        }
    }, {
        key: 'fetch',
        value: function fetch() {
            if (!this.isReady) return Promise.reject(notReadyErrorMessage);
            return this.manager.fetch.apply(this.manager, arguments);
        }
    }, {
        key: 'complete',
        value: function complete() {
            if (!this.isReady) return Promise.reject(notReadyErrorMessage);
            return this.manager.complete.apply(this.manager, arguments);
        }
    }]);

    return PgBoss;
}(EventEmitter);

module.exports = PgBoss;