#!/usr/bin/env node
import * as path from "node:path";
import { VideoEditingMcpServer } from "./index";

const workspaceRoot = process.env.FRAMEFORGE_WORKSPACE_ROOT
  ? path.resolve(process.env.FRAMEFORGE_WORKSPACE_ROOT)
  : process.cwd();

const server = new VideoEditingMcpServer({ workspaceRoot });
server.startStdio();
