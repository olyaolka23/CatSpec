export function parse(text: string): Value;
export function parse(text: string, reviver: Reviver): Value;
export function parse(text: string, reviver?: Reviver): Value {
  return decode(text, reviver);
}
