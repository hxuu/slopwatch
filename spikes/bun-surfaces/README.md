# Spike: Bun surfaces

Throwaway proof that the two Bun surfaces Slopwatch v1 depends on work, as
[ADR-0001](../../docs/adr/0001-bun-everywhere.md) requires: the `pg` Postgres client and OS keychain
access with a 0600 file fallback. Findings and the go/no-go live in
[`research/bun-surfaces-validation.md`](../../research/bun-surfaces-validation.md).

Not a feature. No production module imports this yet; it exists to be run and then deleted, keeping
only its findings.

## Run it

```sh
bun run pg:up     # postgres 17 on 127.0.0.1:55432 via docker
bun run proof     # the human-readable proof; exits non-zero on failure
bun test          # the same, as assertions
bun run compile && ./dist/proof   # the proof as a single binary, the shape ADR-0001 ships
bun run pg:down
```

`SLOPWATCH_SPIKE_DATABASE_URL` overrides the connection string; `--database-url` overrides it per
run. The Postgres test skips itself when no server is listening, and the keychain test exercises the
file fallback when no keychain is present, so the suite passes on a bare machine.

## Files

- `src/postgres.ts` runs a real query and turns a connect failure into a typed error.
- `src/keychain.ts` opens the OS keychain, or a 0600 file when there is none.
- `src/proof.ts` runs both proofs and prints the result.
- `src/*.test.ts` assert the same behaviour against the real services.
