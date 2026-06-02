export interface CompileStreamPort {
  postMessage(data: unknown): void
  close(): void
}

export class WebSocketCompileStreamPort implements CompileStreamPort {
  constructor(private readonly send: (data: unknown) => void) {}

  postMessage(data: unknown): void {
    this.send(data)
  }

  close(): void {
    this.send({ closePort: true })
  }
}
