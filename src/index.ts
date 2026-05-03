interface Env {
  GITHUB_TOKEN: string;
  EPOYA_CACHE: KVNamespace;
  ASSETS: { fetch: typeof fetch };
}

export default {
  async scheduled(event: any, env: Env, ctx: ExecutionContext): Promise<void> {
    await this.performGithubSync(env);
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/stats") {
      const data = await env.EPOYA_CACHE.get("stats");
      return new Response(data || "{}", {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }
    if (url.pathname === "/test-cron") {
      try {
        const result = await this.performGithubSync(env);
        return new Response(`SUCCESS: ${result} commits processed.`, { status: 200 });
      } catch (err: any) {
        return new Response(`CRASHED: ${err.message}`, { status: 500 });
      }
    }
    return env.ASSETS.fetch(request);
  },

  async performGithubSync(env: Env): Promise<number> {
    const repo = "farphel/epoya";
    const token = env.GITHUB_TOKEN;
    const sinceDate = new Date();
    sinceDate.setDate(sinceDate.getDate() - 182); // Rolling 6 months
    const ISO_SINCE = sinceDate.toISOString();

    let allCommits: any[] = [];
    let page = 1;
    let keepFetching = true;

    // BUMPED: Now allows up to 7 pages (700 commits) to provide a safe buffer
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
        if (pageCommits.length < 100) {
          keepFetching = false;
        } else {
          page++;
        }
      }
    }

    const stats = {
      heatmap: {} as Record<string, number>,
      history: allCommits.map((c: any) => ({
        sha: c.sha.substring(0, 7),
        date: c.commit.author.date.split('T')[0],
        author: c.author?.login || "unknown",
        msg: c.commit.message.split('\n')[0]
      }))
    };

    allCommits.forEach((c: any) => {
      const date = c.commit.author.date.split('T')[0];
      stats.heatmap[date] = (stats.heatmap[date] || 0) + 1;
    });

    await env.EPOYA_CACHE.put("stats", JSON.stringify(stats));
    return allCommits.length;
  }
};
