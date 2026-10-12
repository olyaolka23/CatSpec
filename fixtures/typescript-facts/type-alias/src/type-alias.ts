export type UserId = string;

export type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E };

type Handler = (event: Event) => void;
