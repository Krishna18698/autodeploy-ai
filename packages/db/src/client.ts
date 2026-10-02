import postgres from 'postgres';

export type Sql = postgres.Sql;
export type Tx = postgres.TransactionSql;
/** Either a pool or a transaction: helpers accept both. */
export type Db = Sql | Tx;

export function createSql(url: string, opts: { max?: number; application?: string } = {}): Sql {
  return postgres(url, {
    max: opts.max ?? 10,
    idle_timeout: 30,
    connect_timeout: 5,
    prepare: true,
    connection: { application_name: opts.application ?? 'autodeploy' },
    // bigint identity columns come back as JS numbers; ids stay < 2^53.
    types: { bigint: postgres.BigInt },
    transform: { undefined: null },
  });
}
