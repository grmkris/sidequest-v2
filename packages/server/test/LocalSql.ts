import { localSqlOf } from '@sidequest/serving/test/LocalSql'

/** A fresh local D1 with the API Worker's migrations (`packages/server/migrations`) applied. */
export const localSql = () => localSqlOf(new URL('../migrations/', import.meta.url))
