import "dotenv/config";
import express from "express";
import connectToMongoDB from "./lib/mongodb.js";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static("public"));
app.use(express.json());

app.get("/api/release", async (req, res) => {
  try {
    const { db } = await connectToMongoDB();
    const releases = db.collection("releases");

    const release = await releases
      .aggregate([
        {
          $match: {
            cover_url: {
              $exists: true,
              $type: "string",
              $ne: ""
            }
          }
        },
        {
          $sample: {
            size: 1
          }
        }
      ])
      .next();

    console.log(release);

    if (!release) {
      const [totalReleases, releasesWithCoverUrl, releasesWithNonEmptyCoverUrl] =
        await Promise.all([
          releases.estimatedDocumentCount(),
          releases.countDocuments({
            cover_url: {
              $exists: true,
              $ne: null
            }
          }),
          releases.countDocuments({
            cover_url: {
              $type: "string",
              $ne: ""
            }
          })
        ]);

      return res.status(404).json({
        error: "No release found with a non-empty cover_url",
        database: db.databaseName,
        collection: "releases",
        totalReleases,
        releasesWithCoverUrl,
        releasesWithNonEmptyCoverUrl
      });
    }

    res.json(release);
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "Failed to load release"
    });
  }
});

app.listen(PORT, (err) => {
  if (err) {
    console.error(`Failed to start server on port ${PORT}: ${err.message}`);
    process.exit(1);
  }

  console.log(`Running at http://localhost:${PORT}`);
});
