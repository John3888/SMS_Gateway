import { prisma as db } from "../../config/prismaClient.js";
import { Router } from "express";
import { authenticationRoutes } from "../authentication/authentication.routes.js";
import type { loadAdminConfig } from "../../config/env.js";
import type { SmsJob } from "../sms/sms.types.js";

export function createAudit(applications: string[], admin: NonNullable<ReturnType<typeof loadAdminConfig>>, pruneQueue: () => void) {
  let pending = Promise.resolve();
  let writeFailed = false;
  const router = Router();
  router.use(authenticationRoutes(admin));
  router.get("/applications", async (_req, res) => {
    const historical = await db.requestRecord.findMany({
      distinct: ["application"],
      select: { application: true },
    });
    res.json(
      [
        ...new Set([
          ...applications,
          ...historical.map((item) => item.application),
        ]),
      ].sort(),
    );
  });
  router.get("/requests", async (req, res) => {
    pruneQueue();
    const application =
      typeof req.query.application === "string"
        ? req.query.application || undefined
        : undefined;
    const page = Number(req.query.page || 0);
    if (!Number.isSafeInteger(page) || page < 0 || page > 100000) {
      res.status(400).json({ error: "Invalid page" });
      return;
    }
    await pending;
    const rows = await db.requestRecord.findMany({
      where: { application },
      orderBy: [{ created: "desc" }, { id: "desc" }],
      skip: page * 50,
      take: 51,
    });
    res.json({ rows: rows.slice(0, 50), more: rows.length > 50, writeFailed });
  });
  router.get("/requests/:id/logs", async (req, res) => {
    await pending;
    res.json(
      await db.requestEvent.findMany({
        where: { requestId: req.params.id },
        orderBy: { id: "asc" },
      }),
    );
  });
  function record(job: SmsJob) {
    const { id, app_id: application, status } = job;
    const updated = new Date(job.updated_at);
    const created = new Date(job.created_at);
    const detail =
      job.error ||
      (job.modem_reference != null
        ? "Modem reference " + job.modem_reference
        : null);
    const events = { create: { status, at: updated, detail } };
    pending = pending
      .then(async () => {
        await db.requestRecord.upsert({
          where: { id },
          create: { id, application, status, created, updated, events },
          update: { status, updated, events },
        });
      })
      .catch(() => {
        writeFailed = true;
        console.error("Request audit write failed for", id, status);
      });
  }
  return {
    router,
    record,
    async initialize() {
      // A single gateway owns the volatile queue. Outstanding jobs from an earlier process cannot resume.
      const interrupted = await db.requestRecord.findMany({
        where: { status: { in: ["queued", "claimed", "sending"] } },
        select: { id: true },
      });
      for (const { id } of interrupted) {
        const at = new Date();
        await db.requestRecord.update({
          where: { id },
          data: {
            status: "unknown",
            updated: at,
            events: {
              create: {
                status: "unknown",
                at,
                detail: "Gateway restarted before a final result was recorded",
              },
            },
          },
        });
      }
    },
    async close() {
      await pending;
      await db.$disconnect();
    },
  };
}
