import { OperationPromoterError } from "./errors.js";
import { runOperationPromoter } from "./run.js";

function write(
  stream: NodeJS.WriteStream,
  value: Record<string, unknown>,
): void {
  stream.write(
    `${JSON.stringify({ schemaVersion: 1, job: "operation-promoter", ...value })}\n`,
  );
}

export async function main(args: readonly string[]): Promise<number> {
  if (args.length !== 0) {
    write(process.stderr, {
      errorCode: "OPERATION_PROMOTER_CONFIG_INVALID",
      outcome: "failed",
    });
    return 1;
  }
  try {
    const result = await runOperationPromoter();
    write(process.stdout, { ...result });
    return 0;
  } catch (error) {
    const known =
      error instanceof OperationPromoterError
        ? error
        : new OperationPromoterError("OPERATION_PROMOTER_FAILED");
    write(process.stderr, { errorCode: known.code, outcome: "failed" });
    return known.exitCode;
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : undefined;
if (invokedPath === import.meta.url) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      process.exitCode = 1;
    });
}
import { pathToFileURL } from "node:url";
