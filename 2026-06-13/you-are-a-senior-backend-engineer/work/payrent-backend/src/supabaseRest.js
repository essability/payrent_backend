export class SupabaseRest {
  constructor({ url, serviceRoleKey }) {
    this.url = url.replace(/\/$/, "");
    this.serviceRoleKey = serviceRoleKey;
  }

  async select(table, { query = "", single = false } = {}) {
    const rows = await this.request(`/rest/v1/${table}${query}`, {
      method: "GET"
    });
    return single ? rows[0] || null : rows;
  }

  async insert(table, payload, { onConflict, mergeDuplicates = false } = {}) {
    const query = onConflict ? `?on_conflict=${encodeURIComponent(onConflict)}` : "";
    const headers = { Prefer: "return=representation" };
    if (mergeDuplicates) headers.Prefer += ",resolution=merge-duplicates";

    const rows = await this.request(`/rest/v1/${table}${query}`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload)
    });

    return Array.isArray(rows) ? rows[0] : rows;
  }

  async update(table, payload, query) {
    const rows = await this.request(`/rest/v1/${table}${query}`, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(payload)
    });

    return Array.isArray(rows) ? rows[0] || null : rows;
  }

  async rpc(functionName, payload) {
    return this.request(`/rest/v1/rpc/${functionName}`, {
      method: "POST",
      body: JSON.stringify(payload)
    });
  }

  async request(path, options) {
    const response = await fetch(`${this.url}${path}`, {
      ...options,
      headers: {
        apikey: this.serviceRoleKey,
        authorization: `Bearer ${this.serviceRoleKey}`,
        "content-type": "application/json",
        ...(options.headers || {})
      }
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Supabase request failed ${response.status}: ${text}`);
    }

    if (response.status === 204) return null;
    return response.json();
  }
}
