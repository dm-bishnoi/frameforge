#!/usr/bin/env node
import * as path from "node:path";
import { DevelopmentMcpServer } from "./index";

const repoRoot = process.env.FRAMEFORGE_REPO_ROOT
  ? path.resolve(process.env.FRAMEFORGE_REPO_ROOT)
  : process.cwd();

const server = new DevelopmentMcpServer({ repoRoot });
server.startStdio();
