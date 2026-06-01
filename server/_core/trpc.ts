import { NOT_ADMIN_ERR_MSG, UNAUTHED_ERR_MSG } from '@shared/const';
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { TrpcContext } from "./context";

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
});

// Self-healing middleware: log transient errors for observability
const selfHealMiddleware = t.middleware(async ({ next, path }) => {
  try {
    return await next();
  } catch (error) {
    const isTransient = error instanceof Error && (
      error.message.includes('ECONNRESET') ||
      error.message.includes('ETIMEDOUT') ||
      error.message.includes('ECONNREFUSED') ||
      error.message.includes('deadlock') ||
      error.message.includes('Lock wait timeout')
    );
    if (isTransient) {
      console.warn(`[tRPC:SelfHeal] Transient error on ${path}: ${error.message}`);
    }
    throw error;
  }
});

export const router = t.router;
export const publicProcedure = t.procedure.use(selfHealMiddleware);

const requireUser = t.middleware(async opts => {
  const { ctx, next } = opts;

  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
  }

  return next({
    ctx: {
      ...ctx,
      user: ctx.user,
    },
  });
});

export const protectedProcedure = t.procedure.use(selfHealMiddleware).use(requireUser);

export const adminProcedure = t.procedure.use(selfHealMiddleware).use(
  t.middleware(async opts => {
    const { ctx, next } = opts;

    if (!ctx.user || ctx.user.role !== 'admin') {
      throw new TRPCError({ code: "FORBIDDEN", message: NOT_ADMIN_ERR_MSG });
    }

    return next({
      ctx: {
        ...ctx,
        user: ctx.user,
      },
    });
  }),
);
