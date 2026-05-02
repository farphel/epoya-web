// Define the shape of our environment
interface Env {
  GITHUB_TOKEN: string;
  EPOYA_CACHE: KVNamespace;
}

export default {
  // 1. THE SCHEDULED HANDLER (Cron Job)
  async scheduled(event: any, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log("Cron triggered manually or by schedule...");
    await this.performGithubSync(env);
  },

  // 2. THE FETCH HANDLER (Web API)
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // --- DEBUG ROUTE: Visit /test-cron in your browser ---
    if (url.pathname === "/test-cron") {
      try {
        console.log("Manually triggering sync via /test-cron...");
        const result = await this.performGithubSync(env);
        return new Response(`SUCCESS: ${result} commits processed.`, { status: 200 });
      } catch (err: any) {
        // This will print the actual error to your browser screen
        return new Response(`CRASHED: ${err.message}\n\nSTACK: ${err.stack}`, { status: 500 });
      }
    }

    // --- PRODUCTION ROUTE: Your website calls this ---
    const data = await env.EPOYA_CACHE.get("stats");
    return new Response(data || JSON.stringify({ error: "No data in KV yet" }), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*", // Required for your website to read this
      },
    });
  },

  // 3. THE ACTUAL LOGIC (Shared by both handlers)
  async performGithubSync(env: Env): Promise<number> {
    const repo = "farphel/epoya"; // <-- CHANGE THIS to your repo
    const token = env.GITHUB_TOKEN;

    if (!token) {
      throw new Error("GITHUB_TOKEN is missing! Check your .dev.vars file.");
    }

    console.log(`Fetching commits for ${repo}...`);

    const response = await fetch(`https://api.github.com/repos/${repo}/commits?per_page=50`, {
      headers: {
        "Authorization": `Bearer ${token}`,
        "User-Agent": "Cloudflare-Worker-Epoya", // Required by GitHub API
        "Accept": "application/vnd.github+json"
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`GitHub API Error (${response.status}): ${errorText}`);
    }

    const commits: any = await response.json();
    
    // Ensure the response is an array
    if (!Array.isArray(commits)) {
      throw new Error(`Expected array from GitHub, got: ${typeof commits}`);
    }

    // Process data
    const stats = {
      heatmap: {} as Record<string, number>,
      history: commits.slice(0, 10).map((c: any) => ({
        sha: c.sha.substring(0, 7),
        date: c.commit.author.date.split('T')[0],
        authorLogin: c.author?.login || "unknown",
        msg: c.commit.message.split('\n')[0]
      }))
    };

    commits.forEach((c: any) => {
      const date = c.commit.author.date.split('T')[0];
      stats.heatmap[date] = (stats.heatmap[date] || 0) + 1;
    });

    // Save to KV
    if (!env.EPOYA_CACHE) {
      throw new Error("EPOYA_CACHE KV namespace not found! Check wrangler.jsonc");
    }

    await env.EPOYA_CACHE.put("stats", JSON.stringify(stats));
    console.log("KV storage updated successfully.");
    
    return commits.length;
  }
};
