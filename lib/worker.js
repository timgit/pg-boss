'use strict';

var _createClass = function () { function defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ("value" in descriptor) descriptor.writable = true; Object.defineProperty(target, descriptor.key, descriptor); } } return function (Constructor, protoProps, staticProps) { if (protoProps) defineProperties(Constructor.prototype, protoProps); if (staticProps) defineProperties(Constructor, staticProps); return Constructor; }; }();

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

function _possibleConstructorReturn(self, call) { if (!self) { throw new ReferenceError("this hasn't been initialised - super() hasn't been called"); } return call && (typeof call === "object" || typeof call === "function") ? call : self; }

function _inherits(subClass, superClass) { if (typeof superClass !== "function" && superClass !== null) { throw new TypeError("Super expression must either be null or a function, not " + typeof superClass); } subClass.prototype = Object.create(superClass && superClass.prototype, { constructor: { value: subClass, enumerable: false, writable: true, configurable: true } }); if (superClass) Object.setPrototypeOf ? Object.setPrototypeOf(subClass, superClass) : subClass.__proto__ = superClass; }

var EventEmitter = require('events').EventEmitter; //node 0.10 compatibility;

var Worker = function (_EventEmitter) {
    _inherits(Worker, _EventEmitter);

    function Worker(config) {
        _classCallCheck(this, Worker);

        var _this = _possibleConstructorReturn(this, (Worker.__proto__ || Object.getPrototypeOf(Worker)).call(this));

        _this.config = config;
        return _this;
    }

    _createClass(Worker, [{
        key: 'start',
        value: function start() {
            var self = this;

            checkForWork();

            function checkForWork() {
                if (!self.stopped) self.config.fetcher().then(function (job) {
                    if (job) self.emit(self.config.name, job);
                }).catch(function (error) {
                    return self.emit('error', error);
                }).then(function () {
                    return setTimeout(checkForWork, self.config.interval);
                });
            }
        }
    }, {
        key: 'stop',
        value: function stop() {
            this.stopped = true;
        }
    }]);

    return Worker;
}(EventEmitter);

module.exports = Worker;