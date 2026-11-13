// First step of pnpm e2e:start: refuse to build anything for a key or an account that
// cannot run the suite.
import { checkTestAccount, REQUIRED_METHODS } from "../utils/monei.ts";

try {
  const { accountId } = await checkTestAccount();
  process.stdout.write(`MONEI test account ${accountId} offers ${REQUIRED_METHODS.join(", ")}\n`);
} catch (error) {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exitCode = 1;
}
