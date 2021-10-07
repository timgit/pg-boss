'use strict';

var _createClass = function () { function defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ("value" in descriptor) descriptor.writable = true; Object.defineProperty(target, descriptor.key, descriptor); } } return function (Constructor, protoProps, staticProps) { if (protoProps) defineProperties(Constructor.prototype, protoProps); if (staticProps) defineProperties(Constructor, staticProps); return Constructor; }; }();

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

var pg = require('pg');
var Promise = require("bluebird");
var migrations = require('./migrations');

var Db = function () {
    function Db(config) {
        _classCallCheck(this, Db);

        // prefers connection strings over objects
        this.config = config.connectionString || config;
        this.pool = new pg.Pool(this.config);
    }

    _createClass(Db, [{
        key: 'executePreparedSql',
        value: function executePreparedSql(name, text, values) {
            return this.execute({ name: name, text: text, values: values });
        }
    }, {
        key: 'executeSql',
        value: function executeSql(text, values) {
            return this.execute({ text: text, values: values });
        }
    }, {
        key: 'execute',
        value: function execute(query) {
            var pool = this.pool;

            if (query.values && !Array.isArray(query.values)) query.values = [query.values];

            function deferred(resolve, reject) {
                pool.connect(function (err, client, done) {
                    if (err) {
                        reject(err);
                        return done();
                    }

                    client.query(query, function (err, result) {
                        if (err) reject(err);else resolve(result);

                        done();
                    });
                });
            }

            return new Promise(deferred);
        }
    }, {
        key: 'migrate',
        value: function migrate(version, uninstall) {
            var _this = this;

            var migration = migrations.get(this.config.schema, version, uninstall);

            return Promise.each(migration.commands, function (command) {
                return _this.executeSql(command);
            }).then(function () {
                return migration.version;
            });
        }
    }]);

    return Db;
}();

module.exports = Db;