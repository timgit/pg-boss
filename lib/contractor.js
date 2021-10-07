'use strict';

var _createClass = function () { function defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ("value" in descriptor) descriptor.writable = true; Object.defineProperty(target, descriptor.key, descriptor); } } return function (Constructor, protoProps, staticProps) { if (protoProps) defineProperties(Constructor.prototype, protoProps); if (staticProps) defineProperties(Constructor, staticProps); return Constructor; }; }();

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

function _possibleConstructorReturn(self, call) { if (!self) { throw new ReferenceError("this hasn't been initialised - super() hasn't been called"); } return call && (typeof call === "object" || typeof call === "function") ? call : self; }

function _inherits(subClass, superClass) { if (typeof superClass !== "function" && superClass !== null) { throw new TypeError("Super expression must either be null or a function, not " + typeof superClass); } subClass.prototype = Object.create(superClass && superClass.prototype, { constructor: { value: subClass, enumerable: false, writable: true, configurable: true } }); if (superClass) Object.setPrototypeOf ? Object.setPrototypeOf(subClass, superClass) : subClass.__proto__ = superClass; }

var assert = require('assert');
var EventEmitter = require('events').EventEmitter; //node 0.10 compatibility
var Db = require('./db');
var plans = require('./plans');
var migrations = require('./migrations');
var schemaVersion = require('../version.json').schema;
var Promise = require("bluebird");

var Contractor = function (_EventEmitter) {
    _inherits(Contractor, _EventEmitter);

    _createClass(Contractor, null, [{
        key: 'constructionPlans',
        value: function constructionPlans(schema) {
            var exportPlans = plans.createAll(schema);
            exportPlans.push(plans.insertVersion(schema).replace('$1', schemaVersion));

            return exportPlans.join(';\n\n');
        }
    }, {
        key: 'migrationPlans',
        value: function migrationPlans(schema, version, uninstall) {
            var migration = migrations.get(schema, version, uninstall);
            assert(migration, 'migration not found for this version');
            return migration.commands.join(';\n\n');
        }
    }]);

    function Contractor(config) {
        _classCallCheck(this, Contractor);

        var _this = _possibleConstructorReturn(this, (Contractor.__proto__ || Object.getPrototypeOf(Contractor)).call(this));

        _this.config = config;
        _this.db = new Db(config);
        return _this;
    }

    _createClass(Contractor, [{
        key: 'version',
        value: function version() {
            return this.db.executeSql(plans.getVersion(this.config.schema)).then(function (result) {
                return result.rows.length ? result.rows[0].version : null;
            });
        }
    }, {
        key: 'isCurrent',
        value: function isCurrent() {
            return this.version().then(function (version) {
                return version === schemaVersion;
            });
        }
    }, {
        key: 'isInstalled',
        value: function isInstalled() {
            return this.db.executeSql(plans.versionTableExists(this.config.schema)).then(function (result) {
                return result.rows.length ? result.rows[0].name : null;
            });
        }
    }, {
        key: 'ensureCurrent',
        value: function ensureCurrent() {
            var _this2 = this;

            return this.version().then(function (version) {
                if (schemaVersion !== version) return _this2.update(version);
            });
        }
    }, {
        key: 'create',
        value: function create() {
            var _this3 = this;

            return Promise.each(plans.createAll(this.config.schema), function (command) {
                return _this3.db.executeSql(command);
            }).then(function () {
                return _this3.db.executeSql(plans.insertVersion(_this3.config.schema), schemaVersion);
            });
        }
    }, {
        key: 'update',
        value: function update(current) {
            var _this4 = this;

            // temp workaround for bad 0.0.2 schema update
            if (current == '0.0.2') current = '0.0.1';

            return this.db.migrate(current).then(function (version) {
                if (version !== schemaVersion) return _this4.update(version);
            });
        }
    }, {
        key: 'start',
        value: function start() {
            var _this5 = this;

            return this.isInstalled().then(function (installed) {
                return installed ? _this5.ensureCurrent() : _this5.create();
            });
        }
    }, {
        key: 'connect',
        value: function connect() {
            var _this6 = this;

            var connectErrorMessage = 'this version of pg-boss does not appear to be installed in your database. I can create it for you via start().';

            return this.isInstalled().then(function (installed) {
                if (!installed) throw new Error(connectErrorMessage);

                return _this6.isCurrent();
            }).then(function (current) {
                if (!current) throw new Error(connectErrorMessage);
            });
        }
    }]);

    return Contractor;
}(EventEmitter);

module.exports = Contractor;