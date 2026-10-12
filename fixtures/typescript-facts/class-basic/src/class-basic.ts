export class Greeter {
  greeting = "hello";

  greet(name: string): string {
    return `${this.greeting}, ${name}`;
  }
}

class Internal {}
