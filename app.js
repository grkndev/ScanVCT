
import fs from "fs";
import fetch from "node-fetch";
import { parse } from "csv-parse";
import cron from "node-cron";
import deepEqual from "deep-equal";
import dotenv from "dotenv";
import { TwitterApi } from "twitter-api-v2";

dotenv.config();

const twitterV2Client = new TwitterApi({
  appKey: process.env.TWITTER_CONSUMER_KEY,
  appSecret: process.env.TWITTER_CONSUMER_SECRET,
  clientId: process.env.TWITTER_CLIENT_ID,
  clientSecret: process.env.TWITTER_CLIENT_SECRET,
  accessToken: process.env.TWITTER_ACCESS_TOKEN,
  accessSecret: process.env.TOKEN_SECRET,
});

const GIDS = {
  AMERICAS: "1856086064",
  EMEA: "0",
  CN: "1474170664",
  PACIFIC: "1819901194",
};

const BASE_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vRmmWiBmMMD43m5VtZq54nKlmj0ZtythsA1qCpegwx-iRptx2HEsG0T3cQlG1r2AIiKxBWnaurJZQ9Q/pub?gid={{GID}}&output=csv";

function sendNotification(msg, title) {
  fetch("https://exp.host/--/api/v2/push/send", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      to: process.env.NOTF_TOKEN,
      title,
      body: msg,
    }),
  });
}
async function sendTweet(msg) {
  const tweet = `🚨 VCT DATABASE UPDATE 🚨\n\n${msg}\n\n#VCT #VALORANTChampionsTour #VALORANT`;
  twitterV2Client.v2
    .tweet("TWEET", { text: tweet })
    .then((response) => {
      console.log(
        "Tweet sent:",
        `https://x.com/VCTContract/status/${response.data.id}`
      );
    })
    .catch((error) => {
      console.error(error);
    });
}
function createChangeMessage(change, team) {
  switch (change.type) {
    case "player_added":
      return `${change.player.legal_name} "${change.player.name}" ${change.player.legal_surname} has been added to ${team} with a ${change.player.end} contract`;

    case "player_removed":
      return `${change.player.legal_name} "${change.player.name}" ${change.player.legal_surname} has been removed from ${team}`;

    case "player_updated":
      const changes = [];
      if (change.old.status !== change.new.status) {
        changes.push({
          field: "roster status",
          from: change.old.status,
          to: change.new.status,
        });
      }
      if (change.old.end !== change.new.end) {
        changes.push({
          field: "contract end date",
          from: change.old.end,
          to: change.new.end,
        });
      }

      if (changes.length > 0) {
        const playerName = `${change.new.legal_name} "${change.new.name}" ${change.new.legal_surname}`;
        return changes
          .map(
            (c) =>
              `${playerName} (${team}) ${c.field} was changed from ${c.from} to ${c.to}`
          )
          .join("\n");
      }
      return null;

    default:
      return null;
  }
}

function saveUpdate(region, changeType, oldData, changes, timestamp) {
  const updatesFile = "./data/updates.json";
  const messagesFile = "./data/update_messages.json";
  let updates = [];
  let messages = [];

  if (fs.existsSync(updatesFile)) {
    updates = JSON.parse(fs.readFileSync(updatesFile, "utf8"));
  }
  if (fs.existsSync(messagesFile)) {
    messages = JSON.parse(fs.readFileSync(messagesFile, "utf8"));
  }

  const newMessages = [];
  for (const change of changes) {
    if (change.type === "roster_updated") {
      for (const rosterChange of change.changes) {
        const message = createChangeMessage(rosterChange, change.team);
        if (message) {
          sendNotification(message, "Roster updated");
          sendTweet(message);
          newMessages.push({
            timestamp,
            region,
            message,
          });
        }
      }
    } else if (change.type === "team_added") {
      const message = `New team ${change.team} has been added to ${region}`;
      sendNotification(message, "New team added");
      sendTweet(message);
      newMessages.push({
        timestamp,
        region,
        message,
      });
    } else if (change.type === "team_removed") {
      const message = `Team ${change.team} has been removed from ${region}`;
      sendNotification(message, "Team removed");
      sendTweet(message);
      newMessages.push({
        timestamp,
        region,
        message,
      });
    }
  }

  const updateData = {
    timestamp,
    region,
    type: changeType,
    old: oldData,
    changes,
  };

  updates.push(updateData);
  messages = [...newMessages, ...messages];

  fs.writeFileSync(updatesFile, JSON.stringify(updates, null, 2));
  fs.writeFileSync(messagesFile, JSON.stringify(messages, null, 2));

  if (newMessages.length > 0) {
    console.log("\nNew updates:");
    newMessages.forEach((msg) => {
      console.log(`[${msg.region}] ${msg.message}`);
    });
  }
}

function findRosterChanges(oldRoster, newRoster) {
  const changes = [];

  for (const newPlayer of newRoster) {
    const oldPlayer = oldRoster.find((p) => p.name === newPlayer.name);

    if (!oldPlayer) {
      changes.push({
        type: "player_added",
        player: newPlayer,
      });
    } else if (!deepEqual(oldPlayer, newPlayer)) {
      changes.push({
        type: "player_updated",
        player: newPlayer.name,
        old: oldPlayer,
        new: newPlayer,
      });
    }
  }

  for (const oldPlayer of oldRoster) {
    if (!newRoster.find((p) => p.name === oldPlayer.name)) {
      changes.push({
        type: "player_removed",
        player: oldPlayer,
      });
    }
  }

  return changes;
}

async function fetchCSV(url) {
  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers: {
        Accept: "text/csv,text/plain,application/octet-stream",
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP Error: ${response.status}`);
    }

    return await response.text();
  } catch (error) {
    throw new Error(`Fetch failed: ${error.message}`);
  }
}

function parseCSV(csvData) {
  return new Promise((resolve, reject) => {
    parse(
      csvData,
      {
        columns: false,
        skip_empty_lines: false,
        relax_quotes: true,
        trim: true,
      },
      (error, records) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(records);
      }
    );
  });
}
function processTeamData(records) {
  let teams = [];
  let currentTeam = null;
  let skipFirstTwoRows = true;
  let rowCount = 0;

  for (const row of records) {
    rowCount++;

    if (skipFirstTwoRows && rowCount <= 2) {
      continue;
    }

    if (!row.some((cell) => cell.trim() !== "")) {
      currentTeam = null;
      continue;
    }

    const [
      league,
      team,
      tournament,
      role,
      firstName,
      familyName,
      endDate,
      residentStatus,
      rosterStatus,
      teamTag,
      contactInfo,
    ] = row;

    if (!currentTeam || currentTeam.team !== team) {
      if (team && team.trim()) {
        currentTeam = {
          team: team,
          region: league,
          tag: teamTag,
          manager: contactInfo,
          roster: [],
        };
        teams.push(currentTeam);
      }
    }

    if (currentTeam && firstName && familyName) {
      currentTeam.roster.push({
        name: tournament,
        status: rosterStatus,
        end: endDate,
        legal_name: firstName,
        legal_surname: familyName,
      });
    }
  }

  return teams.filter((team) => team.roster.length > 0);
}
function findTeamChanges(oldTeams, newTeams) {
  const changes = [];

  function findTeamChanges(oldTeams, newTeams) {
    const changes = [];

    for (const newTeam of newTeams) {
      const oldTeam = oldTeams.find((t) => t.team === newTeam.team);

      if (!oldTeam) {
        changes.push({
          type: "team_added",
          team: newTeam.team,
          data: newTeam,
        });
      } else if (!deepEqual(oldTeam, newTeam)) {
        const rosterChanges = findRosterChanges(oldTeam.roster, newTeam.roster);
        if (rosterChanges.length > 0) {
          changes.push({
            type: "roster_updated",
            team: newTeam.team,
            changes: rosterChanges,
          });
        }

        const teamInfoChanged = !deepEqual(
          {
            team: oldTeam.team,
            region: oldTeam.region,
            tag: oldTeam.tag,
            manager: oldTeam.manager,
          },
          {
            team: newTeam.team,
            region: newTeam.region,
            tag: newTeam.tag,
            manager: newTeam.manager,
          }
        );

        if (teamInfoChanged) {
          changes.push({
            type: "team_info_updated",
            team: newTeam.team,
            old: {
              region: oldTeam.region,
              tag: oldTeam.tag,
              manager: oldTeam.manager,
            },
            new: {
              region: newTeam.region,
              tag: newTeam.tag,
              manager: newTeam.manager,
            },
          });
        }
      }
    }

    for (const oldTeam of oldTeams) {
      if (!newTeams.find((t) => t.team === oldTeam.team)) {
        changes.push({
          type: "team_removed",
          team: oldTeam.team,
          data: oldTeam,
        });
      }
    }

    return changes;
  }
  for (const newTeam of newTeams) {
    const oldTeam = oldTeams.find((t) => t.team === newTeam.team);

    if (!oldTeam) {
      changes.push({
        type: "team_added",
        team: newTeam.team,
        data: newTeam,
      });
    } else if (!deepEqual(oldTeam, newTeam)) {
      const rosterChanges = findRosterChanges(oldTeam.roster, newTeam.roster);
      if (rosterChanges.length > 0) {
        changes.push({
          type: "roster_updated",
          team: newTeam.team,
          changes: rosterChanges,
        });
      }

      const teamInfoChanged = !deepEqual(
        {
          team: oldTeam.team,
          region: oldTeam.region,
          tag: oldTeam.tag,
          manager: oldTeam.manager,
        },
        {
          team: newTeam.team,
          region: newTeam.region,
          tag: newTeam.tag,
          manager: newTeam.manager,
        }
      );

      if (teamInfoChanged) {
        changes.push({
          type: "team_info_updated",
          team: newTeam.team,
          old: {
            region: oldTeam.region,
            tag: oldTeam.tag,
            manager: oldTeam.manager,
          },
          new: {
            region: newTeam.region,
            tag: newTeam.tag,
            manager: newTeam.manager,
          },
        });
      }
    }
  }

  for (const oldTeam of oldTeams) {
    if (!newTeams.find((t) => t.team === oldTeam.team)) {
      changes.push({
        type: "team_removed",
        team: oldTeam.team,
        data: oldTeam,
      });
    }
  }

  return changes;
}
async function processAllRegions() {
  const timestamp = new Date().toISOString();
  console.log(`\n[${timestamp}] Starting data processing...`);

  try {
    const dataDir = "./data";
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir);
    }

    for (const [region, gid] of Object.entries(GIDS)) {
      try {
        const url = BASE_URL.replace("{{GID}}", gid);
        console.log(`[${timestamp}] Fetching data for ${region}...`);

        const csvData = await fetchCSV(url);
        const records = await parseCSV(csvData);
        const newData = processTeamData(records);

        if (newData.length === 0) {
          throw new Error("No valid data processed");
        }

        const fileName = `${dataDir}/${region.toLowerCase()}.json`;

        let oldData = [];
        if (fs.existsSync(fileName)) {
          oldData = JSON.parse(fs.readFileSync(fileName, "utf8"));
        }

        if (!deepEqual(oldData, newData)) {
          const changes = findTeamChanges(oldData, newData);
          if (changes.length > 0) {
            saveUpdate(region, "changes", oldData, changes, timestamp);
          }

          fs.writeFileSync(fileName, JSON.stringify(newData, null, 2));
          console.log(
            `[${timestamp}] Successfully updated ${newData.length} teams in ${fileName}`
          );
        } else {
          console.log(`[${timestamp}] No changes detected for ${region}`);
        }
      } catch (regionError) {
        console.error(
          `[${timestamp}] Error processing ${region}:`,
          regionError.message
        );
        continue;
      }
    }
    console.log(`[${timestamp}] Processing completed successfully!`);
  } catch (error) {
    console.error(`[${timestamp}] Fatal error:`, error);
  }
}
cron.schedule("*/5 * * * *", () => {
  processAllRegions().catch((error) => {
    console.error("CronJob error:", error);
  });
});

processAllRegions().catch((error) => {
  console.error("Initial run error:", error);
});

console.log("Service started. Data will be updated every 5 minutes.");
