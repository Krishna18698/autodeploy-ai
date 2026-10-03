import { createSql, migrate } from '@autodeploy/db';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer, Wait } from 'testcontainers';
import type { TestProject } from 'vitest/node';

// Real Postgres, Valkey and Kafka for the integration suite, started once.
export default async function setup(project: TestProject) {
  const [pg, valkey, kafka] = await Promise.all([
    new PostgreSqlContainer('postgres:17-alpine')
      .withDatabase('autodeploy')
      .withUsername('autodeploy')
      .withPassword('test')
      .start(),
    new GenericContainer('valkey/valkey:8-alpine')
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
      .start(),
    new GenericContainer('apache/kafka:4.2.0')
      .withExposedPorts({ container: 9092, host: 39092 })
      .withEnvironment({
        KAFKA_NODE_ID: '1',
        KAFKA_PROCESS_ROLES: 'broker,controller',
        KAFKA_LISTENERS: 'PLAINTEXT://:9092,CONTROLLER://:9093',
        KAFKA_ADVERTISED_LISTENERS: 'PLAINTEXT://127.0.0.1:39092',
        KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: 'PLAINTEXT:PLAINTEXT,CONTROLLER:PLAINTEXT',
        KAFKA_CONTROLLER_LISTENER_NAMES: 'CONTROLLER',
        KAFKA_CONTROLLER_QUORUM_VOTERS: '1@localhost:9093',
        KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: '1',
        KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: '1',
        KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: '1',
        KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS: '0',
        KAFKA_AUTO_CREATE_TOPICS_ENABLE: 'false',
      })
      .withWaitStrategy(
        Wait.forLogMessage(/Kafka Server started|Transitioning from RECOVERY to RUNNING/),
      )
      .withStartupTimeout(120_000)
      .start(),
  ]);
  const databaseUrl = pg.getConnectionUri();
  const sql = createSql(databaseUrl, { max: 1 });
  await migrate(sql);
  await sql.end();

  project.provide('databaseUrl', databaseUrl);
  project.provide('valkeyUrl', `redis://127.0.0.1:${valkey.getMappedPort(6379)}`);
  project.provide('kafkaBrokers', '127.0.0.1:39092');

  return async () => {
    await Promise.all([pg.stop(), valkey.stop(), kafka.stop()]);
  };
}

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
    valkeyUrl: string;
    kafkaBrokers: string;
  }
}
