'use strict';

var _createClass = function () { function defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ("value" in descriptor) descriptor.writable = true; Object.defineProperty(target, descriptor.key, descriptor); } } return function (Constructor, protoProps, staticProps) { if (protoProps) defineProperties(Constructor.prototype, protoProps); if (staticProps) defineProperties(Constructor, staticProps); return Constructor; }; }();

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

function _possibleConstructorReturn(self, call) { if (!self) { throw new ReferenceError("this hasn't been initialised - super() hasn't been called"); } return call && (typeof call === "object" || typeof call === "function") ? call : self; }

function _inherits(subClass, superClass) { if (typeof superClass !== "function" && superClass !== null) { throw new TypeError("Super expression must either be null or a function, not " + typeof superClass); } subClass.prototype = Object.create(superClass && superClass.prototype, { constructor: { value: subClass, enumerable: false, writable: true, configurable: true } }); if (superClass) Object.setPrototypeOf ? Object.setPrototypeOf(subClass, superClass) : subClass.__proto__ = superClass; }

var EventEmitter = require('events').EventEmitter; //node 0.10 compatibility;
var Db = require('./db');
var plans = require('./plans');

var Boss = function (_EventEmitter) {
    _inherits(Boss, _EventEmitter);

    function Boss(config) {
        _classCallCheck(this, Boss);

        var _this = _possibleConstructorReturn(this, (Boss.__proto__ || Object.getPrototypeOf(Boss)).call(this));

        _this.db = new Db(config);
        _this.config = config;
        _this.archiveCommand = plans.archive(config.schema);
        return _this;
    }

    _createClass(Boss, [{
        key: 'supervise',
        value: function supervise() {
            var self = this;

            return archive().then(init);

            function archive() {
                return self.db.executeSql(self.archiveCommand, self.config.archiveCompletedJobsEvery).then(function (result) {
                    if (result.rowCount) self.emit('archived', result.rowCount);
                });
            }

            function init() {
                if (self.stopped) return;

                self.archiveTimer = setTimeout(check, self.config.archiveCheckInterval);

                function check() {
                    archive().catch(function (error) {
                        return self.emit('error', error);
                    }).then(init);
                }
            }
        }
    }, {
        key: 'stop',
        value: function stop() {
            var _this2 = this;

            return new Promise(function (resolve, reject) {
                _this2.stopped = true;

                if (_this2.archiveTimer) clearTimeout(_this2.archiveTimer);

                resolve();
            });
        }
    }]);

    return Boss;
}(EventEmitter);

module.exports = Boss;