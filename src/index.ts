interface Env {
  GITHUB_TOKEN: string;
  EPOYA_CACHE: KVNamespace;
  ASSETS: { fetch: typeof fetch };
}

export default {
  // 1. AUTOMATED SYNC
  async scheduled(event: any, env: Env, ctx: ExecutionContext): Promise<void> {
    await this.performGithubSync(env);
  },

  // 2. REQUEST HANDLER
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // API Route: Deliver the raw commit data to the frontend
    if (url.pathname === "/api/stats") {
      const data = await env.EPOYA_CACHE.get("stats");
      return new Response(data || "{}", {
        headers: { 
          "Content-Type": "application/json", 
          "Access-Control-Allow-Origin": "*" 
        }
      });
    }

    // Debug Route: Manually trigger a refresh of the data
    if (url.pathname === "/test-cron") {
      try {
        const result = await this.performGithubSync(env);
        return new Response(`SUCCESS: ${result} commits processed.`, { status: 200 });
      } catch (err: any) {
        return new Response(`CRASHED: ${err.message}`, { status: 500 });
      }
    }

    // Asset Handling: Serve index.html, images, etc.
    if (env.ASSETS && typeof env.ASSETS.fetch === 'function') {
      return env.ASSETS.fetch(request);
    }

    // Fallback: Silent 404 for random bot scans
    return new Response("Not Found", { status: 404 });
  },

  // 3. DATA PROCESSING LOGIC
  async performGithubSync(env: Env): Promise<number> {
    const repo = "farphel/epoya";
    const token = env.GITHUB_TOKEN;
    const sinceDate = new Date();
    sinceDate.setDate(sinceDate.getDate() - 182); // Rolling 6-month window
    const ISO_SINCE = sinceDate.toISOString();

    let allCommits: any[] = [];
    let page = 1;
    let keepFetching = true;

    // Fetch up to 700 commits (7 pages) to handle your high development velocity
    while (keepFetching && page <= 7) { 
      const response = await fetch(
        `https://api.github.com/repos/${repo}/commits?since=${ISO_SINCE}&per_page=100&page=${page}`,
        {
          headers: {
            "Authorization": `Bearer ${token}`,
            "User-Agent": "Epoya-Commit-Check",
            "Accept": "application/vnd.github+json"
          },
        }
      );

      if (!response.ok) throw new Error(`GitHub API Error: ${response.status}`);
      
      const pageCommits: any = await response.json();
      
      if (pageCommits.length === 0) {
        keepFetching = false;
      } else {
        allCommits = allCommits.concat(pageCommits);
        // If we received fewer than 100, there are no more pages to fetch
        if (pageCommits.length < 100) {
          keepFetching = false;
        } else {
          page++;
        }
      }
    }

    // Map the raw data. We preserve the UTC 'rawDate' for the frontend to process local timezones.
    const stats = {
      history: allCommits.map((c: any) => ({
        sha: c.sha.substring(0, 7),
        rawDate: c.commit.author.date, // Preserves UTC format: YYYY-MM-DDTHH:MM:SSZ
        author: c.author?.login || "unknown",
        msg: c.commit.message.split('\n')[0]
      }))
    };

    // Store the updated history in KV
    await env.EPOYA_CACHE.put("stats", JSON.stringify(stats));
    return allCommits.length;
  }
};
