interface Env {
  GITHUB_TOKEN: string;
  EPOYA_CACHE: KVNamespace;
  // This binding provides access to your static files (index.html, images, etc.)
  ASSETS: { fetch: typeof fetch };
}

export default {
  async scheduled(event: any, env: Env, ctx: ExecutionContext): Promise<void> {
    await this.performGithubSync(env);
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // 1. API Route: Fetch the heatmap and history JSON
    if (url.pathname === "/api/stats") {
      const data = await env.EPOYA_CACHE.get("stats");
      return new Response(data || "{}", {
        headers: { 
          "Content-Type": "application/json", 
          "Access-Control-Allow-Origin": "*" 
        }
      });
    }

    // 2. Debug Route: Manually trigger the GitHub sync
    if (url.pathname === "/test-cron") {
      try {
        const result = await this.performGithubSync(env);
        return new Response(`SUCCESS: ${result} commits processed.`, { status: 200 });
      } catch (err: any) {
        return new Response(`CRASHED: ${err.message}`, { status: 500 });
      }
    }

    // 3. Asset Handling & Bot Scan Suppression
    // Check if ASSETS exists before calling it to prevent "undefined" errors in logs
    if (env.ASSETS && typeof env.ASSETS.fetch === 'function') {
      return env.ASSETS.fetch(request);
    }

    // 4. Fallback: Silent 404 for random bot scans (sitemap.xml, etc.)
    return new Response("Not Found", { status: 404 });
  },

  async performGithubSync(env: Env): Promise<number> {
      const repo = "farphel/epoya";
      const token = env.GITHUB_TOKEN;
      const sinceDate = new Date();
      sinceDate.setDate(sinceDate.getDate() - 182);

      const response = await fetch(`https://api.github.com/repos/${repo}/commits?since=${sinceDate.toISOString()}&per_page=100`, {
          headers: {
              "Authorization": `Bearer ${token}`,
              "User-Agent": "Epoya-Commit-Check",
              "Accept": "application/vnd.github+json"
          },
      });

      if (!response.ok) throw new Error(`GitHub API Error: ${response.status}`);
      const commits: any = await response.json();
      
      // Create a simple map for the heatmap using UTC initially to maintain sync
      const heatmap: Record<string, number> = {};
      const history = commits.map((c: any) => {
          const rawDate = c.commit.author.date; // Keeping the 'Z' (UTC) intact
          return {
              sha: c.sha.substring(0, 7),
              rawDate: rawDate, 
              author: c.author?.login || "unknown",
              msg: c.commit.message.split('\n')[0]
          };
      });

      // Store raw data; the frontend will re-calculate the heatmap grouping
      await env.EPOYA_CACHE.put("stats", JSON.stringify({ history }));
      return commits.length;
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
