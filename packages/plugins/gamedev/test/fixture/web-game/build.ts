// Fails when FIXTURE_BUILD_FAIL is set, so the build tool's failure path can be tested.
if (process.env.FIXTURE_BUILD_FAIL) {
  console.error("src/main.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.")
  process.exit(1)
}
console.log("built 1 file")
