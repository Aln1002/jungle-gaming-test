export function parseIntegerSetting(name: string, rawValue: string | undefined, defaultValue: number, minimum: number, maximum: number): number {
  const parsedValue =
    rawValue === undefined || rawValue.trim() === ''
      ? defaultValue
      : Number(rawValue);

  if (
    !Number.isSafeInteger(parsedValue) ||
    parsedValue < minimum ||
    parsedValue > maximum
  ) {
    throw new Error(
      `${name} must be an integer between ${minimum} and ${maximum}`,
    );
  }

  return parsedValue;
}

export function parseHttpUrlSetting(name: string, rawValue: string | undefined, defaultValue?: string): string | undefined {
  const value = rawValue?.trim() || defaultValue;
  if (value === undefined) {
    return undefined;
  }

  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error();
    }
  } catch {
    throw new Error(`${name} must be a valid HTTP or HTTPS URL`);
  }

  return value.replace(/\/+$/, '');
}

export function parsePostgresUrlSetting(name: string, rawValue: string | undefined): string | undefined {
  const value = rawValue?.trim();
  if (!value) {
    return undefined;
  }

  try {
    const url = new URL(value);
    if (
      (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') ||
      !url.hostname
    ) {
      throw new Error();
    }
  } catch {
    throw new Error(`${name} must be a valid PostgreSQL URL`);
  }

  return value;
}
