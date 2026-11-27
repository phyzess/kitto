export async function subtest(context, name, body) {
  try {
    await body(context);
  } catch (error) {
    error.message = `subtest "${name}": ${error.message}`;
    throw error;
  }
}
