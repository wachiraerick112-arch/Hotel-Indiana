// Hotel Indiana POS - backend
// Plain Node + Express + a JSON file as the datastore (no native build
// dependencies, no external database required). Good for a single hotel's
// sales volume; swap readDB/writeDB for a real database later if you grow.

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, "data", "db.json");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function hashPassword(password, salt) {
  return crypto.createHash("sha256").update(salt + ":" + password).digest("hex");
}
function makeAdmin(name, password, role) {
  const salt = crypto.randomBytes(8).toString("hex");
  return { id: null, name: name.trim(), salt, hash: hashPassword(password, salt), role: role || "admin" };
}
function verifyAdmin(db, name, password) {
  const a = (db.admins || []).find(x => x.name.toLowerCase() === String(name || "").trim().toLowerCase());
  if (!a) return null;
  return hashPassword(password, a.salt) === a.hash ? a : null;
}
function getOwner(db) {
  return (db.admins || []).find(a => a.role === "owner");
}
// Every destructive action (deleting a sale, item, expense, held tab, or an
// admin account) must be authorized with the owner's password specifically
// — not just any admin's. This checks a password directly against the
// owner account, regardless of who is currently logged in.
function verifyOwnerPassword(db, password) {
  const owner = getOwner(db);
  if (!owner) return false;
  return hashPassword(password, owner.salt) === owner.hash;
}

// ---------- live notifications (Server-Sent Events) ----------
// Any browser tab with the app open subscribes here; the server pushes an
// event the instant a new M-Pesa sale is saved, so every open tab/device
// shows an alert in real time — no polling needed.
const sseClients = new Set();

app.get("/api/events", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive"
  });
  res.flushHeaders();
  res.write("retry: 2000\n\n");
  sseClients.add(res);
  req.on("close", () => sseClients.delete(res));
});

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) client.write(payload);
}

// ---------- tiny JSON datastore ----------
let writing = Promise.resolve(); // serializes writes so concurrent requests can't corrupt the file

function readDB() {
  const raw = fs.readFileSync(DB_FILE, "utf8");
  const db = JSON.parse(raw);
  if (!db.admins || db.admins.length === 0) {
    // First run, or upgrading from the old single-PIN version: seed one
    // admin so the app never ends up with zero admin accounts. If an old
    // PIN exists, carry it over as that admin's password.
    const legacyPin = db.config && db.config.pin ? db.config.pin : "1234";
    const admin = makeAdmin("Admin", legacyPin, "owner");
    admin.id = nextId(db);
    db.admins = [admin];
    delete db.config;
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); // persist once, synchronously
  } else if (!getOwner(db)) {
    // Upgrading from a version with named admins but no owner concept yet.
    db.admins[0].role = "owner";
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  }
  return db;
}

function writeDB(db) {
  writing = writing.then(() =>
    fs.promises.writeFile(DB_FILE, JSON.stringify(db, null, 2))
  );
  return writing;
}

function nextId(db) {
  const id = String(db.nextId || 1);
  db.nextId = (db.nextId || 1) + 1;
  return id;
}

// ---------- Items ----------
app.get("/api/items", (req, res) => {
  const db = readDB();
  res.json(db.items);
});

app.post("/api/items", async (req, res) => {
  const { name, category, price } = req.body || {};
  if (!name || typeof price !== "number" || price < 0) {
    return res.status(400).json({ error: "name and a valid price are required" });
  }
  const db = readDB();
  const item = { id: nextId(db), name: String(name).trim(), category: String(category || "General").trim(), price };
  db.items.push(item);
  await writeDB(db);
  res.json(item);
});

app.delete("/api/items/:id", async (req, res) => {
  const db = readDB();
  if (!verifyOwnerPassword(db, (req.body || {}).ownerPassword)) {
    return res.status(401).json({ error: "owner password is required to delete" });
  }
  db.items = db.items.filter(i => i.id !== req.params.id);
  await writeDB(db);
  res.json({ ok: true });
});

// ---------- Sales ----------
app.get("/api/sales", (req, res) => {
  const db = readDB();
  res.json(db.sales);
});

app.post("/api/sales", async (req, res) => {
  const { items, subtotal, discount, total, cashAmount, mpesaAmount, mpesaCode, mpesaPaymentId, staff, room, notes } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "at least one item is required" });
  }
  const cash = Number(cashAmount) || 0;
  const mpesa = Number(mpesaAmount) || 0;
  const tot = Number(total) || 0;
  if (Math.abs(cash + mpesa - tot) > 0.01) {
    return res.status(400).json({ error: "cash + mpesa must add up to the total" });
  }

  const db = readDB();

  let finalMpesaCode = mpesaCode ? String(mpesaCode).trim().toUpperCase() : "";
  if (mpesa > 0 && mpesaPaymentId) {
    const p = (db.mpesaPayments || []).find(x => x.id === mpesaPaymentId);
    if (!p) return res.status(400).json({ error: "that M-Pesa payment was not found" });
    if (p.matched) return res.status(409).json({ error: "that M-Pesa payment is already attached to another sale" });
    p.matched = true;
    finalMpesaCode = p.transId;
  }
  if (mpesa > 0 && !finalMpesaCode) {
    return res.status(400).json({ error: "attach an incoming M-Pesa payment, or enter the confirmation code" });
  }
  const today = new Date();
  const date = today.getFullYear() + "-" + String(today.getMonth()+1).padStart(2,"0") + "-" + String(today.getDate()).padStart(2,"0");
  const sale = {
    id: nextId(db),
    date,
    items,
    subtotal: Number(subtotal) || 0,
    discount: Number(discount) || 0,
    total: tot,
    cashAmount: cash,
    mpesaAmount: mpesa,
    mpesaCode: mpesa > 0 ? finalMpesaCode : "",
    staff: (staff || "Unspecified").trim(),
    room: (room || "").trim(),
    notes: (notes || "").trim(),
    createdAt: Date.now()
  };
  db.sales.push(sale);
  await writeDB(db);
  res.json(sale);

  if (sale.mpesaAmount > 0) {
    broadcast("mpesa-sale", {
      amount: sale.mpesaAmount,
      code: sale.mpesaCode,
      items: sale.items.map(i => i.name),
      staff: sale.staff,
      room: sale.room,
      time: sale.createdAt
    });
  }
});

app.delete("/api/sales/:id", async (req, res) => {
  const db = readDB();
  if (!verifyOwnerPassword(db, (req.body || {}).ownerPassword)) {
    return res.status(401).json({ error: "owner password is required to delete" });
  }
  db.sales = db.sales.filter(s => s.id !== req.params.id);
  await writeDB(db);
  res.json({ ok: true });
});

// ---------- Expenses ----------
app.get("/api/expenses", (req, res) => {
  const db = readDB();
  res.json(db.expenses || []);
});

app.post("/api/expenses", async (req, res) => {
  const { description, category, amount, payment, mpesaCode, staff, notes } = req.body || {};
  const amt = Number(amount);
  if (!description || !amt || amt <= 0) {
    return res.status(400).json({ error: "description and a valid amount are required" });
  }
  const pay = payment === "M-Pesa" ? "M-Pesa" : "Cash";
  if (pay === "M-Pesa" && !mpesaCode) {
    return res.status(400).json({ error: "mpesaCode is required when payment is M-Pesa" });
  }
  const db = readDB();
  const today = new Date();
  const date = today.getFullYear() + "-" + String(today.getMonth()+1).padStart(2,"0") + "-" + String(today.getDate()).padStart(2,"0");
  const expense = {
    id: nextId(db),
    date,
    description: String(description).trim(),
    category: String(category || "General").trim(),
    amount: amt,
    payment: pay,
    mpesaCode: pay === "M-Pesa" ? String(mpesaCode).trim().toUpperCase() : "",
    staff: (staff || "Unspecified").trim(),
    notes: (notes || "").trim(),
    createdAt: Date.now()
  };
  if (!db.expenses) db.expenses = [];
  db.expenses.push(expense);
  await writeDB(db);
  res.json(expense);

  if (expense.payment === "M-Pesa") {
    broadcast("mpesa-expense", {
      amount: expense.amount,
      code: expense.mpesaCode,
      description: expense.description,
      staff: expense.staff,
      time: expense.createdAt
    });
  }
});

app.delete("/api/expenses/:id", async (req, res) => {
  const db = readDB();
  if (!verifyOwnerPassword(db, (req.body || {}).ownerPassword)) {
    return res.status(401).json({ error: "owner password is required to delete" });
  }
  db.expenses = (db.expenses || []).filter(e => e.id !== req.params.id);
  await writeDB(db);
  res.json({ ok: true });
});

// ---------- M-Pesa incoming payments (Safaricom Daraja C2B webhook) ----------
// Safaricom calls this URL automatically the instant someone pays your
// till/paybill — see README for how to get a till number and register
// this URL with Safaricom. The path includes a secret so random internet
// traffic can't fake a payment; set MPESA_WEBHOOK_SECRET before deploying.
const MPESA_WEBHOOK_SECRET = process.env.MPESA_WEBHOOK_SECRET || "change-this-secret";

app.post(`/api/mpesa/confirmation/${MPESA_WEBHOOK_SECRET}`, async (req, res) => {
  // Safaricom's C2B confirmation payload (field names are fixed by Safaricom)
  const b = req.body || {};
  const db = readDB();
  const payment = {
    id: nextId(db),
    transId: b.TransID || "",
    amount: Number(b.TransAmount) || 0,
    phone: b.MSISDN || "",
    name: [b.FirstName, b.MiddleName, b.LastName].filter(Boolean).join(" "),
    billRef: b.BillRefNumber || "",
    rawTime: b.TransTime || "",
    receivedAt: Date.now(),
    matched: false
  };
  if (!db.mpesaPayments) db.mpesaPayments = [];
  db.mpesaPayments.push(payment);
  await writeDB(db);
  broadcast("mpesa-incoming", payment);
  // Safaricom requires exactly this acknowledgement shape, or it will retry.
  res.json({ ResultCode: 0, ResultDesc: "Accepted" });
});

// Safaricom also requires a Validation URL if validation is switched on for
// your till. Most tills only use Confirmation, but this is here in case
// yours needs it too — it just accepts everything.
app.post(`/api/mpesa/validation/${MPESA_WEBHOOK_SECRET}`, (req, res) => {
  res.json({ ResultCode: 0, ResultDesc: "Accepted" });
});

// List payments that haven't been attached to a sale yet.
app.get("/api/mpesa/pending", (req, res) => {
  const db = readDB();
  res.json((db.mpesaPayments || []).filter(p => !p.matched));
});

// Staff taps a pending payment while completing a sale — this marks it used
// so it can't be attached twice, and the frontend fills the code/amount in.
app.post("/api/mpesa/match/:id", async (req, res) => {
  const db = readDB();
  const p = (db.mpesaPayments || []).find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: "payment not found" });
  if (p.matched) return res.status(409).json({ error: "already matched to a sale" });
  p.matched = true;
  await writeDB(db);
  res.json(p);
});

app.delete("/api/mpesa/pending/:id", async (req, res) => {
  const db = readDB();
  if (!verifyOwnerPassword(db, (req.body || {}).ownerPassword)) {
    return res.status(401).json({ error: "owner password is required to delete" });
  }
  db.mpesaPayments = (db.mpesaPayments || []).filter(p => p.id !== req.params.id);
  await writeDB(db);
  res.json({ ok: true });
});

// ---------- Held sales (park a sale, work on another, come back to it) ----------
app.get("/api/held", (req, res) => {
  const db = readDB();
  res.json(db.heldSales || []);
});

app.post("/api/held", async (req, res) => {
  const { label, items, discount, staff, room, notes } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "at least one item is required to hold a sale" });
  }
  const db = readDB();
  const held = {
    id: nextId(db),
    label: (label || "").trim() || `Tab ${db.nextId - 1}`,
    items,
    discount: Number(discount) || 0,
    staff: (staff || "").trim(),
    room: (room || "").trim(),
    notes: (notes || "").trim(),
    createdAt: Date.now()
  };
  if (!db.heldSales) db.heldSales = [];
  db.heldSales.push(held);
  await writeDB(db);
  broadcast("held-updated", {});
  res.json(held);
});

app.delete("/api/held/:id", async (req, res) => {
  const { resume, ownerPassword } = req.body || {};
  const db = readDB();
  // Resuming a held sale just moves it back into someone's active cart —
  // nothing is lost, so that doesn't need owner approval. Cancelling it
  // (discarding the order entirely) does, since that's real data removal.
  if (!resume && !verifyOwnerPassword(db, ownerPassword)) {
    return res.status(401).json({ error: "owner password is required to cancel a held sale" });
  }
  db.heldSales = (db.heldSales || []).filter(h => h.id !== req.params.id);
  await writeDB(db);
  broadcast("held-updated", {});
  res.json({ ok: true });
});

// ---------- Named admin accounts ----------
app.post("/api/admin/login", (req, res) => {
  const { name, password } = req.body || {};
  const db = readDB();
  const a = verifyAdmin(db, name, password);
  res.json(a ? { ok: true, name: a.name, role: a.role } : { ok: false });
});

// Names only — not sensitive, used to populate the "manage admins" list.
app.get("/api/admin/list", (req, res) => {
  const db = readDB();
  res.json((db.admins || []).map(a => ({ id: a.id, name: a.name, role: a.role })));
});

// Only the owner (the main admin) can add or remove admin accounts.
app.post("/api/admin/add", async (req, res) => {
  const { ownerPassword, name, password } = req.body || {};
  const db = readDB();
  if (!verifyOwnerPassword(db, ownerPassword)) {
    return res.status(401).json({ error: "owner password is incorrect" });
  }
  if (!name || !password || password.length < 4) {
    return res.status(400).json({ error: "a name and a password (4+ characters) are required" });
  }
  if ((db.admins || []).some(a => a.name.toLowerCase() === name.trim().toLowerCase())) {
    return res.status(409).json({ error: "an admin with that name already exists" });
  }
  const admin = makeAdmin(name, password, "admin");
  admin.id = nextId(db);
  db.admins.push(admin);
  await writeDB(db);
  res.json({ ok: true, name: admin.name });
});

app.delete("/api/admin/:id", async (req, res) => {
  const { ownerPassword } = req.body || {};
  const db = readDB();
  if (!verifyOwnerPassword(db, ownerPassword)) {
    return res.status(401).json({ error: "owner password is incorrect" });
  }
  const target = (db.admins || []).find(a => a.id === req.params.id);
  if (target && target.role === "owner") {
    return res.status(400).json({ error: "can't remove the owner account" });
  }
  db.admins = db.admins.filter(a => a.id !== req.params.id);
  await writeDB(db);
  res.json({ ok: true });
});

// Only the owner can force every other logged-in device back to the login
// screen — e.g. after removing someone, or if a device was left unlocked.
app.post("/api/admin/force-logout", (req, res) => {
  const { ownerPassword } = req.body || {};
  const db = readDB();
  if (!verifyOwnerPassword(db, ownerPassword)) {
    return res.status(401).json({ error: "owner password is incorrect" });
  }
  broadcast("force-logout", {});
  res.json({ ok: true });
});

app.put("/api/admin/:id/password", async (req, res) => {
  const { requesterName, requesterPassword, newPassword } = req.body || {};
  const db = readDB();
  const requester = verifyAdmin(db, requesterName, requesterPassword);
  const asOwner = verifyOwnerPassword(db, requesterPassword); // owner can reset anyone's password
  if (!requester && !asOwner) {
    return res.status(401).json({ error: "your admin password is incorrect" });
  }
  const target = (db.admins || []).find(a => a.id === req.params.id);
  if (!target) return res.status(404).json({ error: "admin not found" });
  if (!asOwner && requester.id !== target.id) {
    return res.status(403).json({ error: "you can only change your own password — ask the owner to reset others" });
  }
  if (!newPassword || newPassword.length < 4) {
    return res.status(400).json({ error: "new password must be at least 4 characters" });
  }
  const salt = crypto.randomBytes(8).toString("hex");
  target.salt = salt;
  target.hash = hashPassword(newPassword, salt);
  await writeDB(db);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Hotel Indiana POS running at http://localhost:${PORT}`);
});
