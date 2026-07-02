const express = require("express");
const router = express.Router();
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { MetaV3Client } = require("./metaV3Client.js");
// const client = new MetaV3Client({
//   certPath: "./certs/adroit_prod.crt",
//   keyPath: "./certs/adroit-private.key",
//   //    isTest: true,
//   //   verbose: true,
// });

let certPath;
let keyPath;

if (process.env.ADROIT_META_CERT && process.env.ADROIT_PRIVATE_KEY) {
  // Render
  const certDir = path.join(__dirname, "certs");
  fs.mkdirSync(certDir, { recursive: true });

  certPath = path.join(certDir, "adroit_prod.crt");
  keyPath = path.join(certDir, "adroit-private.key");

  fs.writeFileSync(certPath, process.env.ADROIT_META_CERT);
  fs.writeFileSync(keyPath, process.env.ADROIT_PRIVATE_KEY);
} else {
  // Local
  certPath = "./certs/adroit_prod.crt";
  keyPath = "./certs/adroit-private.key";
}

const client = new MetaV3Client({
  certPath,
  keyPath,
  // isTest: true,
  // verbose: true,
});
router.get("/test", (req, res) => {
  res.json({
    success: true,
    message: "Working!",
  });
});
router.get("/dispute/metadata", async (req, res) => {
  const result = await client.getDisputeMetadata(req.query.reference_number);
  return res.json(result);
});
router.post("/request-for-information/submit", async (req, res) => {
  const data = req.body;
  const result = await client.submitRfi(data);
  return res.json(result);
});
router.post("/request-for-information/submit/reporter", async (req, res) => {
  const data = req.body;
  const result = await client.submitRfiReporter(data);
  return res.json(result);
});
router.post("/request-for-information/submit/actor", async (req, res) => {
  const data = req.body;
  const result = await client.submitRfiActor(data);
  return res.json(result);
});
router.get("/request-for-information/status", async (req, res, next) => {
  try {
    const { request_id } = req.query;

    const result = await client.getRfiStatus(request_id);

    res.json(result);
  } catch (error) {
    next(error);
  }
});
router.post("/recommendation/submit", async (req, res) => {
  const data = req.body;
  const result = await client.submitRecommendation(data);
  return res.json(result);
});
// router.get("/recommendation/status", async (req, res, next) => {
//   try {
//     const result = await client.getRecommendationStatus(req.query.request_id);
//     console.log("result", result);
//     res.json(result);
//   } catch (err) {
//     next(err);
//   }
// });
router.get("/recommendation/status", async (req, res, next) => {
  console.log("Router hit:", req.query);

  const result = await client.getRecommendationStatus(req.query.request_id);

  res.json(result);
});
module.exports = router;
