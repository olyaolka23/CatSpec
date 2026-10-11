export class Formatter {
  format(value: string): string;
  format(value: number, digits: number): string;
  format(value: string | number, digits?: number): string {
    return String(value);
  }
}

export interface IFormatter {
  format(value: string): string;
  format(value: number, digits: number): string;
}
