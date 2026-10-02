/**
 * "The tests fail, fix it": small models make failing tests pass by editing the tests
 * (`assert.strictEqual(s.pop() || 3, 3)`), or "adjust the test case to match the function's
 * behavior". When the user's message is about failing tests, or forbids changing them,
 * existing test files are read-only for the run, decided by code.
 */

const FAILING_TESTS =
  /\b(tests?|specs?)\b[^.\n]{0,40}\b(fail\w*|broke|broken|red|errors?|don'?t pass|do not pass|not passing)\b|\b(fail\w*|broke|broken|breaks)\b[^.\n]{0,40}\b(tests?|specs?)\b|\b(make|so|until)\s+(that\s+)?(the\s+|all\s+)?(tests?|specs?)\s+pass\b/i;
const HANDS_OFF = /\b(don'?t|do not|never|without)\s+(chang|modif|touch|edit|updat|rewrit)\w*\s+(the\s+|any\s+)?(tests?|specs?)\b/i;
/** Asked for test changes: "add a test", "update the tests", "rename ... in src/ and test/". */
const WANTS_TEST_CHANGES = /\b(add|write|create|update|adjust|extend|rename|move|delete|remove)\b[^.\n]{0,40}\b(tests?|specs?)\b(?!\s+(fail|pass))|\btests?\/|\b(and|including) the tests\b/i;

export function protectTests(message: string): boolean {
  if (HANDS_OFF.test(message)) return true;
  return FAILING_TESTS.test(message) && !WANTS_TEST_CHANGES.test(message.replace(FAILING_TESTS, ""));
}

const TEST_FILE =
  /(^|\/)(test|tests|__tests__|spec|specs)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$|_test\.(py|go)$|(^|\/)[^/]*Tests?\.(cs|java|kt)$|(^|\/)[^/]*\.Tests?\/|_spec\.rb$/i;

export function isTestFile(path: string): boolean {
  return TEST_FILE.test(path);
}

export const TESTS_PROTECTED =
  "is a test. The task is to make the code pass the tests, so the tests must not change. Fix the code they test instead (read the failing assertion to see which function is wrong).";

/** Test declarations: node:test/jest/mocha, pytest/unittest, xUnit/NUnit/MSTest, Go, Rust, JUnit. */
const TEST_DECL = /\b(?:test|it)\s*\(\s*['"`]|^\s*(?:async\s+)?def\s+test_|\[(?:Fact|Theory|Test|TestMethod|TestCase)\b|^\s*func\s+Test\w*\s*\(|#\[test\]|@Test\b/gm;

export function countTests(text: string): number {
  return (text.match(TEST_DECL) ?? []).length;
}

/**
 * Whether the user's message is about tests at all. When it isn't, the agent adds no tests of its
 * own: after a finished fix, 7B models set out to "verify" it with a new test, write a broken one
 * (a variable that shadows the module, an undefined helper) and then fix that instead of finishing.
 */
export function asksForTests(message: string): boolean {
  return /\b(tests?|specs?|testing|coverage)\b/i.test(message);
}

export const NO_NEW_TESTS = "The user didn't ask for tests, so don't add any: the project's checks run by themselves when you call done. If the change is complete, call done now.";
