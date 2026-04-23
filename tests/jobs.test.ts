import { createSyncJob, getJob, listJobs, cleanupOldJobs } from "../src/jobs";

describe("jobs", () => {
  beforeEach(() => {
    // Reset the jobs module before each test
    jest.resetModules();
  });

  describe("createSyncJob", () => {
    it("should create a job with pending status", () => {
      const job = createSyncJob();
      
      expect(job.id).toBeDefined();
      expect(job.id.startsWith("job_")).toBe(true);
      expect(job.type).toBe("sync");
      expect(job.status).toBe("pending");
      expect(job.progress).toBe(0);
      expect(job.total).toBe(0);
    });

    it("should generate unique job IDs", () => {
      const job1 = createSyncJob();
      const job2 = createSyncJob();
      
      expect(job1.id).not.toBe(job2.id);
    });

    it("should have started_at timestamp", () => {
      const job = createSyncJob();
      
      expect(job.started_at).toBeDefined();
      expect(new Date(job.started_at).getTime()).toBeLessThanOrEqual(Date.now());
    });
  });

  describe("getJob", () => {
    it("should return undefined for non-existent job", () => {
      const result = getJob("non-existent-id");
      expect(result).toBeUndefined();
    });

    it("should return created job", () => {
      const created = createSyncJob();
      const retrieved = getJob(created.id);
      
      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(created.id);
    });
  });

  describe("listJobs", () => {
    it("should return empty array initially", () => {
      const jobs = listJobs();
      expect(Array.isArray(jobs)).toBe(true);
    });

    it("should return created jobs", () => {
      createSyncJob();
      createSyncJob();
      
      const jobs = listJobs();
      expect(jobs.length).toBeGreaterThanOrEqual(2);
    });
  });
});