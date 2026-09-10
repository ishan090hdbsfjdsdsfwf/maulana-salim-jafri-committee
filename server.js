const express = require('express');
const path = require('path');
const mongoose = require('mongoose');
const crypto = require('crypto');
const Razorpay = require('razorpay');
const ExcelJS = require('exceljs');
require('dotenv').config();

const app = express();


// ---------- Razorpay ----------
let razorpay = null;

if (
    process.env.RAZORPAY_KEY_ID &&
    process.env.RAZORPAY_KEY_SECRET
) {
    razorpay = new Razorpay({
        key_id: process.env.RAZORPAY_KEY_ID,
        key_secret: process.env.RAZORPAY_KEY_SECRET
    });

    console.log('Razorpay configured successfully');
} else {
    console.error(
        'WARNING: Razorpay environment variables are missing.'
    );
}


// ---------- Middleware ----------
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Serve the project-root index.html
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});


// ---------- MongoDB connection ----------
console.log("========== MONGODB TEST ==========");
console.log("MONGODB_URI exists:", !!process.env.MONGODB_URI);
console.log("MONGODB_URI prefix:", process.env.MONGODB_URI?.substring(0, 20));

mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log("========== MongoDB connected =========="))
    .catch(err => console.error("========== MongoDB ERROR ==========", err));
// ---------- Registration schema ----------
const registrationSchema = new mongoose.Schema({
    _id: { type: String },

    name: String,
    dob: String,
    fatherName: String,
    email: String,
    phone: String,
    address: String,
    bloodGroup: String,

    aadhaar: {
        type: String,
        required: true,
        unique: true
    },

    idProofType: String,
    photo: String,
    idProofPhoto: String,

    isBatsman: Boolean,
    isBowler: Boolean,

    battingStyle: String,
    bowlingArm: String,
    bowlingType: String,

    lowerSize: String,
    tshirtSize: String,

    jerseyNumber: String,
    jerseyName: String,

    event: String,

    paymentAmount: {
        type: Number,
        default: 700
    },

    paymentMethod: {
        type: String,
        default: 'UPI QR'
    },

    paymentUtr: String,
    paymentScreenshot: String,

    razorpayOrderId: String,
    razorpayPaymentId: String,
    razorpaySignature: String,

    paymentStatus: {
        type: String,
        default: 'Pending Verification'
    },

    createdAt: {
        type: Date,
        default: Date.now
    }
});


const Registration = mongoose.model(
    'Registration',
    registrationSchema
);


// ---------- Settings (for registration open/closed toggle) ----------
const settingsSchema = new mongoose.Schema({
    _id: { type: String, default: 'main' },
    registrationOpen: { type: Boolean, default: true }
});

const Settings = mongoose.model('Settings', settingsSchema);

async function getSettings() {
    let settings = await Settings.findById('main');
    if (!settings) {
        settings = await Settings.create({ _id: 'main', registrationOpen: true });
    }
    return settings;
}

// Public endpoint: frontend checks this before showing/allowing the form
app.get('/registration-status', async (req, res) => {
    try {
        const settings = await getSettings();
        res.json({ open: settings.registrationOpen });
    } catch (err) {
        console.error('Error fetching registration status:', err);
        res.json({ open: true }); // fail open so a DB hiccup doesn't block real registrations
    }
});


// ---------- Registration submission ----------
app.post('/submit-registration', async (req, res) => {

    try {

        const settings = await getSettings();
        if (!settings.registrationOpen) {
            return res.status(403).json({
                success: false,
                message: 'Registration is currently closed.'
            });
        }

        const formData = req.body;

        if (!formData.aadhaar) {
            return res.status(400).json({
                success: false,
                message: 'Aadhaar number is required.'
            });
        }

        if (!/^\d{12}$/.test(formData.aadhaar)) {
            return res.status(400).json({
                success: false,
                message: 'Please enter a valid 12-digit Aadhaar number.'
            });
        }

        const existing = await Registration.findById(
            formData.aadhaar
        );

        if (existing) {
            return res.status(409).json({
                success: false,
                message: 'A registration with this Aadhaar number already exists.'
            });
        }

        const registration = new Registration({

            _id: formData.aadhaar,

            name: formData.name,
            dob: formData.dob,
            fatherName: formData.fatherName,
            email: formData.email,
            phone: formData.phone,
            address: formData.address,
            bloodGroup: formData.bloodGroup,

            aadhaar: formData.aadhaar,

            idProofType: formData.idProofType,
            photo: formData.photo,
            idProofPhoto: formData.idProofPhoto,

            isBatsman: formData.isBatsman,
            isBowler: formData.isBowler,

            battingStyle: formData.battingStyle,
            bowlingArm: formData.bowlingArm,
            bowlingType: formData.bowlingType,

            lowerSize: formData.lowerSize,
            tshirtSize: formData.tshirtSize,

            jerseyNumber: formData.jerseyNumber,
            jerseyName: formData.jerseyName,

            event: formData.event,

            paymentAmount: 700,
            paymentMethod: 'UPI QR',

            paymentUtr: formData.paymentUtr || '',
            paymentScreenshot: formData.paymentScreenshot || '',

            paymentStatus: 'Pending Verification'
        });

        await registration.save();

        res.json({
            success: true,
            message: 'Registration submitted successfully.',
            registrationId: registration._id
        });

    } catch (err) {

        console.error('Registration error:', err);

        if (err.code === 11000) {
            return res.status(409).json({
                success: false,
                message: 'This Aadhaar number is already registered.'
            });
        }

        res.status(500).json({
            success: false,
            message: 'Registration could not be saved.'
        });
    }
});


// ---------- Razorpay order ----------
app.post('/create-order', async (req, res) => {

    try {

        const settings = await getSettings();
        if (!settings.registrationOpen) {
            return res.status(403).json({
                error: 'Registration is currently closed.'
            });
        }

        if (!razorpay) {
            return res.status(500).json({
                error: 'Razorpay is not configured on the server.'
            });
        }

        const aadhaar = String(
            req.body.aadhaar || ''
        ).trim();

        if (!/^\d{12}$/.test(aadhaar)) {
            return res.status(400).json({
                error: 'Please enter a valid 12-digit Aadhaar number.'
            });
        }

        const existing = await Registration.findById(aadhaar);

        if (existing) {
            return res.status(409).json({
                error: 'A registration with this Aadhaar number already exists.'
            });
        }

        // ₹700 = 70,000 paise
        const amount = 70000;

        const order = await razorpay.orders.create({
            amount: amount,
            currency: 'INR',
            receipt: `MPL-${aadhaar}`,
            notes: {
                event: 'MPL Registration',
                aadhaar: aadhaar
            }
        });

        return res.json({
            id: order.id,
            amount: order.amount,
            currency: order.currency,
            keyId: process.env.RAZORPAY_KEY_ID
        });

    } catch (err) {

        console.error(
            'Razorpay order error:',
            err
        );

        return res.status(500).json({
            error: 'Could not create Razorpay payment order. Check the server logs.'
        });
    }
});


// ---------- Razorpay payment verification + registration save ----------
app.post('/verify-payment', async (req, res) => {

    try {

        if (!razorpay) {
            return res.status(500).json({
                success: false,
                message: 'Razorpay is not configured on the server.'
            });
        }

        if (
            !process.env.RAZORPAY_KEY_SECRET
        ) {
            return res.status(500).json({
                success: false,
                message: 'Razorpay secret is not configured on the server.'
            });
        }

        const {
            razorpay_order_id,
            razorpay_payment_id,
            razorpay_signature,
            formData
        } = req.body;

        if (
            !razorpay_order_id ||
            !razorpay_payment_id ||
            !razorpay_signature ||
            !formData
        ) {
            return res.status(400).json({
                success: false,
                message: 'Incomplete payment verification data.'
            });
        }

        const generatedSignature = crypto
            .createHmac(
                'sha256',
                process.env.RAZORPAY_KEY_SECRET
            )
            .update(
                `${razorpay_order_id}|${razorpay_payment_id}`
            )
            .digest('hex');

        if (
            generatedSignature !== razorpay_signature
        ) {
            return res.status(400).json({
                success: false,
                message: 'Payment verification failed.'
            });
        }

        const razorpayOrder =
            await razorpay.orders.fetch(
                razorpay_order_id
            );

        if (
            Number(razorpayOrder.amount) !== 70000 ||
            razorpayOrder.currency !== 'INR'
        ) {
            return res.status(400).json({
                success: false,
                message: 'Payment amount could not be verified.'
            });
        }

        const aadhaar = String(
            formData.aadhaar || ''
        ).trim();

        if (!/^\d{12}$/.test(aadhaar)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid Aadhaar number.'
            });
        }

        const existing =
            await Registration.findById(aadhaar);

        if (existing) {
            return res.status(409).json({
                success: false,
                message: 'A registration with this Aadhaar number already exists.'
            });
        }

        const registration =
            new Registration({

                _id: aadhaar,

                name: formData.name,
                dob: formData.dob,
                fatherName: formData.fatherName,
                email: formData.email,
                phone: formData.phone,
                address: formData.address,
                bloodGroup: formData.bloodGroup,

                aadhaar: aadhaar,

                idProofType: formData.idProofType,
                photo: formData.photo,
                idProofPhoto: formData.idProofPhoto,

                isBatsman: formData.isBatsman,
                isBowler: formData.isBowler,

                battingStyle: formData.battingStyle,
                bowlingArm: formData.bowlingArm,
                bowlingType: formData.bowlingType,

                lowerSize: formData.lowerSize,
                tshirtSize: formData.tshirtSize,

                jerseyNumber: formData.jerseyNumber,
                jerseyName: formData.jerseyName,

                event: formData.event,

                paymentAmount: 700,
                paymentMethod: 'Razorpay',

                razorpayOrderId:
                    razorpay_order_id,

                razorpayPaymentId:
                    razorpay_payment_id,

                razorpaySignature:
                    razorpay_signature,

                paymentStatus: 'Paid'
            });

        await registration.save();

        return res.json({
            success: true,
            message: 'Payment successful. MPL registration confirmed!',
            registrationId: registration._id
        });

    } catch (err) {

        console.error(
            'Payment verification/registration error:',
            err
        );

        if (err.code === 11000) {
            return res.status(409).json({
                success: false,
                message: 'This Aadhaar number is already registered.'
            });
        }

        return res.status(500).json({
            success: false,
            message: 'Payment was received, but registration could not be saved. Please contact the committee.'
        });
    }
});


// ---------- Admin authentication ----------
function checkAdminAuth(req, res, next) {

    const auth = req.headers.authorization;

    if (
        !auth ||
        !auth.startsWith('Basic ')
    ) {

        res.set(
            'WWW-Authenticate',
            'Basic realm="Admin"'
        );

        return res.status(401).send(
            'Login required'
        );
    }

    const decoded = Buffer
        .from(
            auth.split(' ')[1],
            'base64'
        )
        .toString();

    const separatorIndex =
        decoded.indexOf(':');

    if (separatorIndex === -1) {
        return res.status(401).send(
            'Wrong username or password'
        );
    }

    const user =
        decoded.substring(
            0,
            separatorIndex
        );

    const pass =
        decoded.substring(
            separatorIndex + 1
        );

    if (
        user === process.env.ADMIN_USER &&
        pass === process.env.ADMIN_PASSWORD
    ) {
        return next();
    }

    res.set(
        'WWW-Authenticate',
        'Basic realm="Admin"'
    );

    return res.status(401).send(
        'Wrong username or password'
    );
}


// ---------- Admin page ----------
app.get(
    '/admin',
    checkAdminAuth,
    async (req, res) => {

        try {

            const settings = await getSettings();

            const registrations =
                await Registration.find()
                    .sort({ createdAt: -1 });

            const rows =
                registrations.map(r => `

            <tr>

                <td>
                    ${r.photo
                        ? `<img src="${r.photo}"
                                style="width:40px;height:40px;
                                object-fit:cover;
                                border-radius:4px;">`
                        : ''
                    }
                </td>

                <td>
                    ${r.idProofPhoto
                        ? `<a href="${r.idProofPhoto}" target="_blank"><img src="${r.idProofPhoto}"
                                style="width:40px;height:40px;
                                object-fit:cover;
                                border-radius:4px;"></a>`
                        : ''
                    }
                </td>

                <td>${r.name || ''}</td>
                <td>${r.dob || ''}</td>
                <td>${r.fatherName || ''}</td>
                <td>${r.phone || ''}</td>
                <td>${r.email || ''}</td>
                <td>${r.bloodGroup || ''}</td>

                <td>
                    ${[
                        r.isBatsman
                            ? 'Batsman'
                            : '',
                        r.isBowler
                            ? 'Bowler'
                            : ''
                    ]
                        .filter(Boolean)
                        .join(', ')
                    }
                </td>

                <td>${r.battingStyle || ''}</td>
                <td>${r.bowlingType || ''}</td>

                <td>
                    ${r.jerseyNumber || ''}
                    ${r.jerseyName || ''}
                </td>

                <td>${r.event || ''}</td>

                <td>₹${r.paymentAmount || 700}</td>

                <td>${r.paymentUtr || ''}</td>

                <td>${r.paymentStatus || ''}</td>

                <td>
                    ${r.createdAt
                        ? new Date(
                            r.createdAt
                        ).toLocaleString()
                        : ''
                    }
                </td>

                <td>
                    <form method="POST" action="/admin/delete-registration/${r.aadhaar}"
                        onsubmit="return confirm('Delete registration for ${(r.name || '').replace(/'/g, "\\'")}? This cannot be undone.');"
                        style="margin:0;">
                        <button type="submit" style="
                            background:#B5462F;
                            color:#fff;
                            border:none;
                            padding:6px 12px;
                            border-radius:4px;
                            cursor:pointer;
                            font-size:13px;
                        ">Delete</button>
                    </form>
                </td>

            </tr>

        `).join('');


            res.send(`

<!DOCTYPE html>

<html>

<head>

<title>Registrations</title>

<style>

body {
    font-family: Arial, sans-serif;
    padding: 24px;
}

table {
    border-collapse: collapse;
    width: 100%;
    margin-top: 16px;
}

th,
td {
    border: 1px solid #ccc;
    padding: 8px 12px;
    text-align: left;
    font-size: 14px;
}

th {
    background: #16342B;
    color: white;
}

tr:nth-child(even) {
    background: #f6f3ea;
}

a.btn {
    display: inline-block;
    margin-top: 16px;
    padding: 10px 18px;
    background: #D8A33C;
    color: #0E241E;
    text-decoration: none;
    font-weight: bold;
}

</style>

</head>

<body>

<h2>
    Registrations (${registrations.length} total)
</h2>

<div style="
    display:flex;
    align-items:center;
    gap:14px;
    padding:14px 18px;
    margin-bottom:16px;
    border-radius:6px;
    background:${settings.registrationOpen ? '#e7f3ea' : '#fbe9e7'};
    border:1px solid ${settings.registrationOpen ? '#16342B' : '#B5462F'};
">
    <span style="font-weight:bold; color:${settings.registrationOpen ? '#16342B' : '#B5462F'};">
        Registration is currently ${settings.registrationOpen ? 'OPEN' : 'CLOSED'}
    </span>

    <a
        href="/admin/toggle-registration"
        class="btn"
        style="
            margin-top:0;
            background:${settings.registrationOpen ? '#B5462F' : '#16342B'};
            color:#fff;
        "
    >
        ${settings.registrationOpen ? 'Close Registration' : 'Open Registration'}
    </a>
</div>

<a class="btn" href="/admin/export">
    Download CSV
</a>

<a
    class="btn"
    href="/admin/export-auction"
    style="background:#16342B;color:#fff;margin-left:10px;"
>
    Download for Cricauction
</a>

<table>

<tr>

<th>Photo</th>
<th>ID Photo</th>
<th>Name</th>
<th>DOB</th>
<th>Father's Name</th>
<th>Phone</th>
<th>Email</th>
<th>Blood Group</th>
<th>Role</th>
<th>Batting</th>
<th>Bowling</th>
<th>Jersey</th>
<th>Event</th>
<th>Fee</th>
<th>UTR</th>
<th>Payment Status</th>
<th>Date</th>
<th>Action</th>

</tr>

${rows}

</table>

</body>

</html>

        `);

        } catch (err) {

            console.error(err);

            res.status(500).send(
                'Could not load registrations.'
            );
        }
    }
);


// ---------- Toggle registration open/closed ----------
app.get(
    '/admin/toggle-registration',
    checkAdminAuth,
    async (req, res) => {

        try {

            const settings = await getSettings();
            settings.registrationOpen = !settings.registrationOpen;
            await settings.save();

            res.redirect('/admin');

        } catch (err) {

            console.error('Error toggling registration status:', err);
            res.status(500).send('Could not update registration status.');
        }
    }
);


// ---------- Delete a registration ----------
app.post(
    '/admin/delete-registration/:aadhaar',
    checkAdminAuth,
    async (req, res) => {

        try {

            const { aadhaar } = req.params;

            const deleted = await Registration.findByIdAndDelete(aadhaar);

            if (!deleted) {
                return res.status(404).send('Registration not found.');
            }

            res.redirect('/admin');

        } catch (err) {

            console.error('Error deleting registration:', err);
            res.status(500).send('Could not delete registration.');
        }
    }
);


// ---------- Export CSV ----------
app.get(
    '/admin/export',
    checkAdminAuth,
    async (req, res) => {

        try {

            const registrations =
                await Registration.find()
                    .sort({ createdAt: -1 });

            const baseUrl = req.protocol + '://' + req.get('host');

            let csv =
                'Name,DOB,Father Name,Phone,Email,Address,Blood Group,Aadhaar,ID Proof,Role,Batting Style,Bowling Arm,Bowling Type,Lower Size,T-shirt Size,Jersey Number,Jersey Name,Event,Payment Amount,Payment UTR,Payment Status,Player Photo URL,ID Proof Photo URL,Date\n';

            registrations.forEach(r => {

                const role = [
                    r.isBatsman
                        ? 'Batsman'
                        : '',
                    r.isBowler
                        ? 'Bowler'
                        : ''
                ]
                    .filter(Boolean)
                    .join('/');

                const row = [

                    r.name,
                    r.dob,
                    r.fatherName,
                    r.phone,
                    r.email,
                    r.address,
                    r.bloodGroup,
                    r.aadhaar,
                    r.idProofType,
                    role,
                    r.battingStyle,
                    r.bowlingArm,
                    r.bowlingType,
                    r.lowerSize,
                    r.tshirtSize,
                    r.jerseyNumber,
                    r.jerseyName,
                    r.event,
                    r.paymentAmount || 700,
                    r.paymentUtr,
                    r.paymentStatus,
                    r.photo ? `${baseUrl}/photo/${r.aadhaar}/player` : '',
                    r.idProofPhoto ? `${baseUrl}/photo/${r.aadhaar}/idproof` : '',
                    r.createdAt
                        ? new Date(
                            r.createdAt
                        ).toLocaleString()
                        : ''

                ]
                    .map(field =>
                        `"${(field || '')
                            .toString()
                            .replace(
                                /"/g,
                                '""'
                            )}"`
                    )
                    .join(',');

                csv += row + '\n';

            });

            res.setHeader(
                'Content-Type',
                'text/csv'
            );

            res.setHeader(
                'Content-Disposition',
                'attachment; filename=registrations.csv'
            );

            res.send(csv);

        } catch (err) {

            console.error(err);

            res.status(500).send(
                'Export failed.'
            );
        }

    }
);


// ---------- Serve a registrant's photo as a real image URL ----------
// (used in CSV/Excel exports, since spreadsheets can't render raw base64 data)
app.get(
    '/photo/:aadhaar/:type',
    checkAdminAuth,
    async (req, res) => {

        try {

            const { aadhaar, type } = req.params;

            if (!['player', 'idproof'].includes(type)) {
                return res.status(400).send('Invalid photo type.');
            }

            const registration = await Registration.findById(aadhaar);

            if (!registration) {
                return res.status(404).send('Registration not found.');
            }

            const dataUrl = type === 'player'
                ? registration.photo
                : registration.idProofPhoto;

            if (!dataUrl) {
                return res.status(404).send('No photo on file.');
            }

            // dataUrl looks like: data:image/jpeg;base64,/9j/4AAQ...
            const match = dataUrl.match(/^data:(image\/[a-zA-Z]+);base64,(.+)$/);

            if (!match) {
                return res.status(500).send('Photo data is in an unexpected format.');
            }

            const contentType = match[1];
            const buffer = Buffer.from(match[2], 'base64');

            res.setHeader('Content-Type', contentType);
            res.send(buffer);

        } catch (err) {
            console.error('Error serving photo:', err);
            res.status(500).send('Could not load photo.');
        }
    }
);


// ---------- Public candidate photo (no login) ----------
// Used by the Cricauction app to load the player photo from the exported file.
// Only the player's own photo is public here — the Aadhaar/ID proof photo
// stays admin-only through the /photo/:aadhaar/:type route above.
app.get('/player-photo/:aadhaar', async (req, res) => {

    try {

        const { aadhaar } = req.params;

        const registration = await Registration.findById(aadhaar);

        if (!registration || !registration.photo) {
            return res.status(404).send('Photo not found.');
        }

        const match = registration.photo.match(/^data:(image\/[a-zA-Z]+);base64,(.+)$/);

        if (!match) {
            return res.status(500).send('Photo data is in an unexpected format.');
        }

        const contentType = match[1];
        const buffer = Buffer.from(match[2], 'base64');

        res.setHeader('Content-Type', contentType);
        res.send(buffer);

    } catch (err) {
        console.error('Error serving player photo:', err);
        res.status(500).send('Could not load photo.');
    }
});


// ---------- Cricauction export ----------
app.get(
    '/admin/export-auction',
    checkAdminAuth,
    async (req, res) => {

        try {

            const registrations =
                await Registration.find()
                    .sort({ createdAt: 1 });

            const baseUrl = req.protocol + '://' + req.get('host');

            const header = [

                'No',
                'NAME',
                'PHONE',
                'PHOTO',
                'AGE',
                'SKILL',
                'SPECIFICATION 1',
                'SPECIFICATION 2',
                'SPECIFICATION 3',
                'CATEGORY',
                'EXTRA DETAILS',
                'JERSEY NAME',
                'JERSEY NO',
                'JERSEY SIZE',
                'TROUSER SIZE',
                'BASE VALUE',
                'MATCH',
                'RUN',
                'WICKET',
                'CUSTOM DATA',
                'INFO 1',
                'INFO 2',
                'INFO 3',
                'INFO 4',
                'INFO 5',
                'INFO 6',
                'UPLOAD IMAGE 1',
                'UPLOAD IMAGE 2'

            ];

            const skillFor = r => {

                if (
                    r.isBatsman &&
                    r.isBowler
                ) {
                    return 'All Rounder';
                }

                if (r.isBatsman) {
                    return 'Batsman';
                }

                if (r.isBowler) {
                    return 'Bowler';
                }

                return '';
            };

            const ageFromDob = dob => {

                if (!dob) {
                    return '';
                }

                const birth =
                    new Date(dob);

                if (isNaN(birth)) {
                    return '';
                }

                const diff =
                    Date.now() -
                    birth.getTime();

                return Math.floor(
                    diff /
                    (
                        1000 *
                        60 *
                        60 *
                        24 *
                        365.25
                    )
                );
            };

            const workbook = new ExcelJS.Workbook();
            const sheet = workbook.addWorksheet('Sheet1');

            sheet.addRow(header);

            registrations.forEach(
                (r, i) => {

                    // Only one photo goes in the file — the candidate's own
                    // photo, in the PHOTO column, via a link that doesn't
                    // need admin login so the Cricauction app can load it.
                    const photoUrl = r.photo
                        ? `${baseUrl}/player-photo/${r.aadhaar}`
                        : '';

                    sheet.addRow([

                        i + 1,
                        r.name || '',
                        r.phone || '',
                        photoUrl,
                        ageFromDob(r.dob),
                        skillFor(r),
                        r.battingStyle || '',
                        r.bowlingArm || '',
                        r.bowlingType || '',

                        '',
                        r.address || '',
                        r.jerseyName || '',
                        r.jerseyNumber || '',
                        r.tshirtSize || '',
                        r.lowerSize || '',

                        '',
                        '',
                        '',
                        '',
                        '',

                        '',
                        '',
                        '',
                        '',
                        '',
                        '',

                        '',
                        ''

                    ]);

                }
            );

            res.setHeader(
                'Content-Type',
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            );

            res.setHeader(
                'Content-Disposition',
                'attachment; filename=cricauction-upload.xlsx'
            );

            await workbook.xlsx.write(res);
            res.end();

        } catch (err) {

            console.error(err);

            res.status(500).send(
                'Auction export failed.'
            );
        }

    }
);


// ---------- Start server ----------
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {

    console.log(
        'Server running on port ' + PORT
    );

});