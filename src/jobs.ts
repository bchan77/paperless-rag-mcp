/**
 * Jobs Module
 * 
 * Manages background jobs for long-running operations like document sync.
 */

export type JobStatus = "pending" | "running" | "completed" | "failed";

export interface Job {
  id: string;
  type: "sync";
  status: JobStatus;
  progress: number;
  total: number;
  message: string;
  result?: unknown;
  error?: string;
  started_at: string;
  completed_at?: string;
}

// In-memory job storage (for single-instance MCP server)
// In production, this could be Redis or a database
const jobs: Map<string, Job> = new Map();

function generateJobId(): string {
  return `job_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

export function createSyncJob(): Job {
  const job: Job = {
    id: generateJobId(),
    type: "sync",
    status: "pending",
    progress: 0,
    total: 0,
    message: "Job created",
    started_at: new Date().toISOString(),
  };
  jobs.set(job.id, job);
  return job;
}

export function getJob(jobId: string): Job | undefined {
  return jobs.get(jobId);
}

export function updateJobProgress(jobId: string, progress: number, total: number, message: string): void {
  const job = jobs.get(jobId);
  if (job) {
    job.status = "running";
    job.progress = progress;
    job.total = total;
    job.message = message;
  }
}

export function completeJob(jobId: string, result: unknown): void {
  const job = jobs.get(jobId);
  if (job) {
    job.status = "completed";
    job.progress = job.total;
    job.result = result;
    job.completed_at = new Date().toISOString();
    job.message = "Completed successfully";
  }
}

export function failJob(jobId: string, error: string): void {
  const job = jobs.get(jobId);
  if (job) {
    job.status = "failed";
    job.error = error;
    job.completed_at = new Date().toISOString();
    job.message = `Failed: ${error}`;
  }
}

export function listJobs(): Job[] {
  return Array.from(jobs.values()).sort((a, b) => 
    new Date(b.started_at).getTime() - new Date(a.started_at).getTime()
  );
}

// Cleanup old jobs (older than 24 hours)
export function cleanupOldJobs(): void {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [id, job] of jobs) {
    const jobTime = new Date(job.started_at).getTime();
    if (jobTime < cutoff) {
      jobs.delete(id);
    }
  }
}

// Run cleanup on module load
cleanupOldJobs();
