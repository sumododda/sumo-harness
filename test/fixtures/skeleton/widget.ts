/** Exercises every shape a skeleton must carry, and every shape it must not. */

export class Widget {
  private readonly name: string;
  private count = 0;

  constructor(name: string) {
    this.name = name;
  }

  async render(size: number): Promise<string> {
    let total = size + this.count;
    for (let i = 0; i < total; i += 1) {
      total += i;
    }
    return `${this.name}:${total}`;
  }
}

export function makeWidget(name: string): Widget {
  return new Widget(name);
}

export const DEFAULT_SIZE = 10;

const secret = 'never shown — not exported, so not part of the public surface';

void secret;
