export async function subtest<T>(context: T, name: string, body: (context: T) => unknown): Promise<void> {
  try {
    await body(context);
  } catch (error) {
    if (error instanceof Error) error.message = `subtest "${name}": ${error.message}`;
    throw error;
  }
}
