interface CommitData {
  sha: string;
  rawDate: string;
  author: string;
  msg: string;
  filesChanged?: number;
  additions?: number;
  deletions?: number;
  hasStats?: boolean; // The structural marker to check for deep-dive completion
}

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
        return new Response(`SUCCESS: ${result}`, { status: 200 });
      } catch (err: any) {
        return new Response(`CRASHED: ${err.message}`, { status: 500 });
      }
    }

    if (env.ASSETS && typeof env.ASSETS.fetch === 'function') {
      return env.ASSETS.fetch(request);
    }

    return new Response("Not Found", { status: 404 });
  },

  async performGithubSync(env: Env): Promise<string> {
    const repo = "farphel/epoya";
    const token = env.GITHUB_TOKEN;
    
    // 1. Fetch current database snapshot from KV
    const cachedDataRaw = await env.EPOYA_CACHE.get("stats");
    let cachedHistory: CommitData[] = [];
    if (cachedDataRaw) {
      try {
        const parsed = JSON.parse(cachedDataRaw);
        if (parsed && Array.isArray(parsed.history)) {
          cachedHistory = parsed.history;
        }
      } catch (e) {}
    }

    // Map existing cache by SHA for seamless attribute merging
    const cacheMap = new Map(cachedHistory.map(c => [c.sha, c]));

    // 2. Fetch the comprehensive rolling list from GitHub (up to 700 commits)
    const sinceDate = new Date();
    sinceDate.setDate(sinceDate.getDate() - 182);
    const ISO_SINCE = sinceDate.toISOString();

    let fetchedCommits: any[] = [];
    let page = 1;
    let keepFetching = true;

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

      if (!response.ok) throw new Error(`GitHub List Error: ${response.status}`);
      const pageCommits: any = await response.json();
      
      if (pageCommits.length === 0) {
        keepFetching = false;
      } else {
        fetchedCommits = fetchedCommits.concat(pageCommits);
        if (pageCommits.length < 100) keepFetching = false;
        else page++;
      }
    }

    // 3. Construct baseline manifest from fresh GitHub data
    // If a commit is already cached AND has stats, preserve it. Otherwise, mark it for audit.
    const baselineHistory: CommitData[] = fetchedCommits.map((c: any) => {
      const shaShort = c.sha.substring(0, 7);
      const existing = cacheMap.get(shaShort);

      if (existing && existing.hasStats) {
        return existing; // Keep intact
      }

      return {
        sha: shaShort,
        rawDate: c.commit.author.date,
        author: c.author?.login || "unknown",
        msg: c.commit.message.split('\n')[0],
        hasStats: false // Missing metadata marker
      };
    });

    // 4. Identify exactly which items need processing (most recent first)
    const unspentCommits = baselineHistory.filter(c => !c.hasStats);
    
    let processedCount = 0;
    // Process a max quota of 20 targets per cycle
    const targetsToProcess = unspentCommits.slice(0, 20);

    for (const commit of targetsToProcess) {
      // Find the true full SHA from our original fetched list to query the detail endpoint
      const fullCommitRef = fetchedCommits.find(fc => fc.sha.startsWith(commit.sha));
      if (!fullCommitRef) continue;

      const detailResponse = await fetch(
        `https://api.github.com/repos/${repo}/commits/${fullCommitRef.sha}`,
        {
          headers: {
            "Authorization": `Bearer ${token}`,
            "User-Agent": "Epoya-Commit-Check",
            "Accept": "application/vnd.github+json"
          },
        }
      );

      if (detailResponse.ok) {
        const detailedData: any = await detailResponse.json();
        
        // Update the item properties in-place within our baseline history array
        commit.filesChanged = detailedData.files?.length || 0;
        commit.additions = detailedData.stats?.additions || 0;
        commit.deletions = detailedData.stats?.deletions || 0;
        commit.hasStats = true; // Set marker so it is skipped tomorrow
        processedCount++;
      }
    }

    // 5. Enforce chronological sort order and clamp size limits
    baselineHistory.sort((a, b) => new Date(b.rawDate).getTime() - new Date(a.rawDate).getTime());
    const finalHistory = baselineHistory.slice(0, 700);

    // Persist finalized records back to KV
    await env.EPOYA_CACHE.put("stats", JSON.stringify({ history: finalHistory }));
    
    const remainingMissing = finalHistory.filter(c => !c.hasStats).length;
    return `Sync completed. Filled ${processedCount} entries. ${remainingMissing} commits left to backfill.`;
  }
};