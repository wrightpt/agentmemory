import type { ISdk } from 'iii-sdk'

export class StateKV {
  constructor(private sdk: ISdk) {}

  async get<T = unknown>(scope: string, key: string): Promise<T | null> {
    // The iii-engine resolves `state::get` with `undefined` (an absent
    // result field) for missing keys, not `null`. Normalize here so the
    // declared `T | null` contract holds — callers compare against `null`
    // with strict equality (e.g. rebaseActionMutation's create path).
    const value = await this.sdk.trigger<{ scope: string; key: string }, T | null>({
      function_id: 'state::get',
      payload: { scope, key },
    })
    return value ?? null
  }

  async set<T = unknown>(scope: string, key: string, value: T): Promise<T> {
    return this.sdk.trigger<{ scope: string; key: string; value: T }, T>({
      function_id: 'state::set',
      payload: { scope, key, value },
    })
  }

  async update<T = unknown>(
    scope: string,
    key: string,
    ops: Array<{ type: string; path: string; value?: unknown }>,
  ): Promise<T> {
    return this.sdk.trigger<
      { scope: string; key: string; ops: Array<{ type: string; path: string; value?: unknown }> },
      T
    >({
      function_id: 'state::update',
      payload: { scope, key, ops },
    })
  }

  async delete(scope: string, key: string): Promise<void> {
    return this.sdk.trigger<{ scope: string; key: string }, void>({
      function_id: 'state::delete',
      payload: { scope, key },
    })
  }

  async list<T = unknown>(scope: string): Promise<T[]> {
    return this.sdk.trigger<{ scope: string }, T[]>({
      function_id: 'state::list',
      payload: { scope },
    })
  }
}
