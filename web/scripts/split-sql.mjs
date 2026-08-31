/**
 * Split a SQL file into individually executable statements.
 *
 * Extracted from init-db.mjs so it can be tested directly. It has to be: an earlier version
 * discarded any statement whose chunk began with a comment, and because every CREATE TABLE in
 * schema.sql is introduced by a comment block, that silently dropped every table and left only the
 * indexes - which then failed with "relation ... does not exist".
 */

/**
 * @param {string} sql
 * @returns {string[]} statements, comment-only lines removed, in file order
 */
export function splitSqlStatements(sql) {
  // Own-line comments are removed before splitting so they cannot mask the statement they document.
  // Only whole-line comments are touched, which keeps any `--` inside a string literal intact.
  const withoutComments = sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');

  // Statements are separated by a semicolon at end of line, so multi-line CREATEs stay intact.
  return withoutComments
    .split(/;\s*$/m)
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}
