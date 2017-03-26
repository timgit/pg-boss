module.exports = {
  get
};

function get(schema, version, uninstall) {
  let migrations = getMigrations(schema);

  for(let m=0; m<migrations.length; m++){
    let migration = migrations[m];

    let targetVersion = uninstall ? 'previous' : 'version';
    let sourceVersion = uninstall ? 'version' : 'previous';

    let targetCommands = uninstall ? 'uninstall' : 'install';

    if(migration[sourceVersion] === version){
      let commands = migration[targetCommands].concat();
      commands.push(`UPDATE ${schema}.version SET version = '${migration[targetVersion]}';`);

      return {
        version: migration[targetVersion],
        commands
      };
    }
  }
}

function getMigrations(schema) {
  return [
    {
      version: '0.1.0',
      previous: '0.0.1',
      install: [
        `ALTER TABLE ${schema}.job ADD singletonOn timestamp without time zone`,
        `ALTER TABLE ${schema}.job ADD CONSTRAINT job_singleton UNIQUE(name, singletonOn)`,
        // one time truncate because previous schema was inserting each version
        `TRUNCATE TABLE ${schema}.version`,
        `INSERT INTO ${schema}.version(version) values('0.0.1')`
      ],
      uninstall: [
        `ALTER TABLE ${schema}.job DROP CONSTRAINT job_singleton`,
        `ALTER TABLE ${schema}.job DROP COLUMN singletonOn`
      ]
    },
    {
      version: '2',
      previous: '0.1.0',
      install: [
        `CREATE TYPE ${schema}.job_state AS ENUM ('created','retry','active','complete','expired','cancelled')`,
        `ALTER TABLE ${schema}.job ALTER COLUMN state SET DATA TYPE ${schema}.job_state USING state::${schema}.job_state`,
        `ALTER TABLE ${schema}.job DROP CONSTRAINT job_singleton`,
        `ALTER TABLE ${schema}.job ADD singletonKey text`,
        `CREATE UNIQUE INDEX job_singletonKey ON ${schema}.job (name, singletonKey) WHERE state < 'complete' AND singletonOn IS NULL`,
        `CREATE UNIQUE INDEX job_singletonOn ON ${schema}.job (name, singletonOn) WHERE state < 'expired' AND singletonKey IS NULL`,
        `CREATE UNIQUE INDEX job_singletonKeyOn ON ${schema}.job (name, singletonOn, singletonKey) WHERE state < 'expired'`,
        // migrate data to use retry state
        `UPDATE ${schema}.job SET state = 'retry' WHERE state = 'expired' AND retryCount < retryLimit`,
        // expired jobs weren't being archived in prev schema
        `UPDATE ${schema}.job SET completedOn = now() WHERE state = 'expired' and retryLimit = retryCount`,
        // just using good ole fashioned completedOn
        `ALTER TABLE ${schema}.job DROP COLUMN expiredOn`
      ],
      uninstall: [
        `ALTER TABLE ${schema}.job ADD expiredOn timestamp without time zone`,
        `DROP INDEX ${schema}.job_singletonKey`,
        `DROP INDEX ${schema}.job_singletonOn`,
        `DROP INDEX ${schema}.job_singletonKeyOn`,
        `ALTER TABLE ${schema}.job DROP COLUMN singletonKey`,
        `ALTER TABLE ${schema}.job ALTER COLUMN state SET DATA TYPE text`,
        `DROP TYPE ${schema}.job_state`,
        // restoring prev unique constraint
        `ALTER TABLE ${schema}.job ADD CONSTRAINT job_singleton UNIQUE(name, singletonOn)`,
        // roll retry state back to expired
        `UPDATE ${schema}.job SET state = 'expired' where state = 'retry'`
      ]
    },
    {
      version: '3',
      previous: '2',
      install: [
        `ALTER TYPE ${schema}.job_state ADD VALUE IF NOT EXISTS 'failed' AFTER 'cancelled'`
      ],
      uninstall: [
        // There is currently no simple syntax like ALTER TYPE my_enum REMOVE VALUE my_value
        // Also, we'd have to remove the data during uninstall and who would enjoy that?
        // The migration committee decided to allow a leaky migration here since rollbacks are edge cases
        //   and IF NOT EXISTS will not throw on re-application
      ]
    }
  ];
}
