/**
 * A value the operator must read exactly once: the setup code, an access
 * code, a generated admin token. It is not a string, so no log call accepts
 * it, and it prints as "[secret]" wherever it is turned into text (a template
 * literal, JSON, util.inspect). `log.banner` is the one writer that reveals
 * it, to stdout only; code that must use the value (hashing it, a test)
 * calls `reveal()`.
 */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return "[secret]";
  }

  toJSON(): string {
    return "[secret]";
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return "[secret]";
  }
}
