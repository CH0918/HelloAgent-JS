/**
 * 真实使用示例 -- 09-03 Neo4j 业务关系图
 *
 * 场景：把客户、系统、团队和问题写成图谱实体，再从客户出发查相关实体。
 *
 * 运行：
 *   pnpm build
 *   node examples/09-03-neo4j-business-demo.mjs
 */

import { config as loadDotenv } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(__dirname, ".env") });

import { Neo4jGraphStore } from "../dist/index.js";

const dataSource = "09-03-neo4j-business-demo";

function readEnv(name) {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : undefined;
}

function readIntegerEnv(name, fallback) {
  const raw = readEnv(name);
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function uniqueById(items) {
  const seen = new Set();
  return items.filter((item) => {
    const id = String(item.id ?? "");
    if (!id || seen.has(id)) {
      return false;
    }
    seen.add(id);
    return true;
  });
}

const graph = new Neo4jGraphStore({
  uri: readEnv("NEO4J_URI"),
  username: readEnv("NEO4J_USERNAME") ?? readEnv("NEO4J_USER"),
  password: readEnv("NEO4J_PASSWORD"),
  database: readEnv("NEO4J_DATABASE"),
  maxConnectionLifetime: readIntegerEnv("NEO4J_MAX_CONNECTION_LIFETIME", 3600),
  maxConnectionPoolSize: readIntegerEnv("NEO4J_MAX_CONNECTION_POOL_SIZE", 50),
  connectionAcquisitionTimeout: readIntegerEnv("NEO4J_CONNECTION_TIMEOUT", 60),
});

const entities = [
  {
    id: "demo-09-03-customer-xinghe",
    name: "杭州星河零售",
    type: "CUSTOMER",
    properties: {
      industry: "retail",
      tier: "enterprise",
      data_source: dataSource,
    },
  },
  {
    id: "demo-09-03-system-order-sync",
    name: "订单同步系统",
    type: "SYSTEM",
    properties: {
      owner: "integration",
      data_source: dataSource,
    },
  },
  {
    id: "demo-09-03-team-integration-support",
    name: "集成支持团队",
    type: "TEAM",
    properties: {
      channel: "support-oncall",
      data_source: dataSource,
    },
  },
  {
    id: "demo-09-03-issue-sales-report-gap",
    name: "销售报表缺数",
    type: "ISSUE",
    properties: {
      severity: "high",
      data_source: dataSource,
    },
  },
];

const relationships = [
  {
    from: "demo-09-03-customer-xinghe",
    to: "demo-09-03-system-order-sync",
    type: "USES",
    properties: { reason: "客户订单依赖该系统同步", data_source: dataSource },
  },
  {
    from: "demo-09-03-system-order-sync",
    to: "demo-09-03-team-integration-support",
    type: "OWNED_BY",
    properties: { reason: "该团队负责排查同步任务", data_source: dataSource },
  },
  {
    from: "demo-09-03-issue-sales-report-gap",
    to: "demo-09-03-customer-xinghe",
    type: "IMPACTS",
    properties: { reason: "销售看板缺少晚间订单数据", data_source: dataSource },
  },
  {
    from: "demo-09-03-issue-sales-report-gap",
    to: "demo-09-03-system-order-sync",
    type: "RELATED_TO",
    properties: { reason: "根因可能来自订单同步失败批次", data_source: dataSource },
  },
];

try {
  const ready = await graph.healthCheck();
  if (!ready) {
    throw new Error("无法连接 Neo4j。请检查 NEO4J_URI / NEO4J_USERNAME / NEO4J_PASSWORD / NEO4J_DATABASE。");
  }

  for (const entity of entities) {
    await graph.addEntity(entity.id, entity.name, entity.type, entity.properties);
  }

  for (const relationship of relationships) {
    await graph.addRelationship(relationship.from, relationship.to, relationship.type, relationship.properties);
  }

  const customers = await graph.searchEntitiesByName("杭州星河", {
    entityTypes: ["CUSTOMER"],
    limit: 3,
  });
  const customer = customers[0];
  if (!customer?.id) {
    throw new Error("没有找到示例客户实体。");
  }

  const relatedEntities = await graph.findRelatedEntities(String(customer.id), {
    maxDepth: 2,
    limit: 10,
  });
  const uniqueRelatedEntities = uniqueById(relatedEntities);
  const directRelationships = await graph.getEntityRelationships(String(customer.id));
  const stats = await graph.getStats();

  console.log("== 09-03 Neo4j 业务关系图 ==");
  console.log("Neo4j URI:", graph.uri);
  console.log("数据库:", graph.database);

  console.log("\n查询客户:");
  console.log(`${customer.name} (${customer.type})`);

  console.log("\n直接关系:");
  for (const item of directRelationships) {
    const relationship = item.relationship ?? {};
    const other = item.other_entity ?? {};
    console.log(`- ${item.direction}: ${relationship.type} -> ${other.name} (${other.type})`);
    if (relationship.reason) {
      console.log(`  原因: ${relationship.reason}`);
    }
  }

  console.log("\n两跳内相关实体:");
  for (const entity of uniqueRelatedEntities) {
    console.log(`- ${entity.name} (${entity.type}), distance=${entity.distance}, path=${entity.relationship_path?.join(" -> ")}`);
  }

  console.log("\n图数据库统计:");
  console.log(`Entity nodes: ${stats.entity_nodes}`);
  console.log(`Relationships: ${stats.total_relationships}`);
} catch (error) {
  console.error("09-03 Neo4j 业务关系图示例运行失败。");
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await graph.close().catch(() => undefined);
}
