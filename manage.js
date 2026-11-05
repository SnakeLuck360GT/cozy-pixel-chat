// Account management from the command line, mainly for creating the first
// account. Everything else can be done from the admin page.
//
//   node manage.js add-user <name> [--admin] [--owner]
//   node manage.js set-owner <name>
//   node manage.js reset-password <name>
//   node manage.js delete-user <name>
//   node manage.js list
//
// On the server, run these through the wrapper: sudo chat-admin add-user yourname --owner

import { rm } from "node:fs/promises";
import path from "node:path";
import { HttpError, generatePassword, hashPassword, validUsername } from "./lib/auth.js";
import { config } from "./lib/config.js";
import { deleteUser, openDb } from "./lib/db.js";

const db = openDb(config.dbFile);
const [command, nameArg, ...flags] = process.argv.slice(2);

function findUser(name) {
  const user = db.get("SELECT * FROM users WHERE name = ?", name);
  if (!user) throw new HttpError(404, `No user called ${name}`);
  return user;
}

try {
  if (command === "add-user") {
    const name = validUsername(nameArg);
    const password = generatePassword();
    const passwordHash = await hashPassword(password);
    const role = flags.includes("--owner") ? "owner" : flags.includes("--admin") ? "admin" : "member";
    if (db.get("SELECT 1 FROM users WHERE name = ?", name)) throw new HttpError(409, `${name} already exists`);
    if (role === "owner") db.run("UPDATE users SET role = 'admin' WHERE role = 'owner'");
    db.run("INSERT INTO users (name, password_hash, role, created) VALUES (?, ?, ?, ?)", name, passwordHash, role, Date.now());
    console.log(`Created ${role === "member" ? "" : `${role} `}${name}. Password: ${password}`);
    console.log("Change it after logging in, in Settings.");
  } else if (command === "set-owner") {
    // The owner manages everyone else's accounts; there's one.
    const user = findUser(validUsername(nameArg));
    db.transaction(() => {
      db.run("UPDATE users SET role = 'admin' WHERE role = 'owner'");
      db.run("UPDATE users SET role = 'owner' WHERE id = ?", user.id);
    });
    console.log(`${user.name} is now the owner`);
  } else if (command === "reset-password") {
    const user = findUser(validUsername(nameArg));
    const password = generatePassword();
    db.run("UPDATE users SET password_hash = ? WHERE id = ?", await hashPassword(password), user.id);
    db.run("DELETE FROM sessions WHERE user_id = ?", user.id);
    console.log(`New password for ${user.name}: ${password}`);
  } else if (command === "delete-user") {
    const user = findUser(validUsername(nameArg));
    const { keys } = deleteUser(db, user.id);
    await Promise.all(keys.map((key) => rm(path.join(config.filesDir, key), { force: true })));
    console.log(`Deleted ${user.name} and ${keys.length} file(s)`);
  } else if (command === "list") {
    for (const u of db.all("SELECT name, role FROM users ORDER BY created")) {
      console.log(`${u.name}${u.role === "member" ? "" : ` (${u.role})`}`);
    }
  } else {
    console.log("Usage: node manage.js add-user <name> [--admin] [--owner] | set-owner <name> | reset-password <name> | delete-user <name> | list");
    process.exitCode = 1;
  }
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}
