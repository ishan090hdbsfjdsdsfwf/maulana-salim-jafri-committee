const express = require('express');
const path = require('path');
const mongoose = require('mongoose');
const crypto = require('crypto');
const Razorpay = require('razorpay');
const ExcelJS = require('exceljs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

require('dotenv').config();

const app = express();


// ============================================================
// TRUST RENDER PROXY
// ============================================================

app.set('trust proxy', 1);


// ============================================================
// CRASH SAFETY
// ============================================================

process.on('uncaughtException', (err) => {
    console.error(
        'UNCAUGHT EXCEPTION — server kept running:',
        err
    );
});

process.on('unhandledRejection', (reason) => {
    console.error(
        'UNHANDLED PROMISE REJECTION — server kept running:',
        reason
    );
});


// ============================================================
// RAZORPAY
// ============================================================

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


// ============================================================
// MIDDLEWARE
// ============================================================

app.use(
    helmet({
        contentSecurityPolicy: false
    })
);

app.use(
    express.json({
        limit: '10mb'
    })
);

app.use(
    express.urlencoded({
        extended: true,
        limit: '10mb'
    })
);

app.use(
    express.static(
        path.join(__dirname, 'public')
    )
);


// ============================================================
// RATE LIMITERS
// ============================================================

const generalLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false
});

app.use(generalLimiter);


const adminLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: 'Too many attempts. Please try again later.'
});


const submitLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 15,
    standardHeaders: true,
    legacyHeaders: false,
    message: 'Too many attempts. Please wait a bit and try again.'
});


// ============================================================
// CONCURRENCY GUARD
// ============================================================

const MAX_CONCURRENT_HEAVY_REQUESTS = 6;

let activeHeavyRequests = 0;

function concurrencyGuard(req, res, next) {

    if (
        activeHeavyRequests >=
        MAX_CONCURRENT_HEAVY_REQUESTS
    ) {

        return res.status(503).json({
            error: 'high_traffic',
            message:
                'The site is getting a lot of registrations right now. Please wait a moment and try again.',
            retryAfterSeconds: 20
        });

    }

    activeHeavyRequests++;

    let released = false;

    const release = () => {

        if (!released) {

            released = true;

            activeHeavyRequests--;

        }

    };

    res.on('finish', release);
    res.on('close', release);

    next();
}


// ============================================================
// HOME PAGE
// ============================================================

app.get('/', (req, res) => {

    res.sendFile(
        path.join(
            __dirname,
            'index.html'
        )
    );

});


// ============================================================
// MONGODB
// ============================================================

console.log('========== MONGODB TEST ==========');

console.log(
    'MONGODB_URI exists:',
    !!process.env.MONGODB_URI
);

console.log(
    'MONGODB_URI prefix:',
    process.env.MONGODB_URI
        ?.substring(0, 20)
);


mongoose
    .connect(process.env.MONGODB_URI)
    .then(() => {

        console.log(
            '========== MongoDB connected =========='
        );

    })
    .catch((err) => {

        console.error(
            '========== MongoDB ERROR ==========',
            err
        );

    });


// ============================================================
// REGISTRATION SCHEMA
// ============================================================

const registrationSchema =
    new mongoose.Schema({

        _id: {
            type: String
        },

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

        isAllRounder: Boolean,

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


const Registration =
    mongoose.model(
        'Registration',
        registrationSchema
    );


// ============================================================
// SETTINGS SCHEMA
// ============================================================

const settingsSchema =
    new mongoose.Schema({

        _id: {
            type: String,
            default: 'main'
        },

        registrationOpen: {
            type: Boolean,
            default: true
        }

    });


const Settings =
    mongoose.model(
        'Settings',
        settingsSchema
    );


async function getSettings() {

    let settings =
        await Settings.findById('main');

    if (!settings) {

        settings =
            await Settings.create({
                _id: 'main',
                registrationOpen: true
            });

    }

    return settings;
}


// ============================================================
// PUBLIC REGISTRATION STATUS
// ============================================================

app.get(
    '/registration-status',
    async (req, res) => {

        try {

            const settings =
                await getSettings();

            res.json({
                open:
                    settings.registrationOpen
            });

        } catch (err) {

            console.error(
                'Error fetching registration status:',
                err
            );

            res.json({
                open: true
            });

        }

    }
);


// ============================================================
// PUBLIC REGISTRATION
// ============================================================

app.post(
    '/submit-registration',
    submitLimiter,
    concurrencyGuard,
    async (req, res) => {

        try {

            const settings =
                await getSettings();

            if (
                !settings.registrationOpen
            ) {

                return res.status(403).json({
                    success: false,
                    message:
                        'Registration is currently closed.'
                });

            }

            const formData =
                req.body;

            if (!formData.aadhaar) {

                return res.status(400).json({
                    success: false,
                    message:
                        'Aadhaar number is required.'
                });

            }

            if (
                !/^\d{12}$/.test(
                    formData.aadhaar
                )
            ) {

                return res.status(400).json({
                    success: false,
                    message:
                        'Please enter a valid 12-digit Aadhaar number.'
                });

            }

            const existing =
                await Registration.findById(
                    formData.aadhaar
                );

            if (existing) {

                return res.status(409).json({
                    success: false,
                    message:
                        'A registration with this Aadhaar number already exists.'
                });

            }

            const registration =
                new Registration({

                    _id:
                        formData.aadhaar,

                    name:
                        formData.name,

                    dob:
                        formData.dob,

                    fatherName:
                        formData.fatherName,

                    email:
                        formData.email,

                    phone:
                        formData.phone,

                    address:
                        formData.address,

                    bloodGroup:
                        formData.bloodGroup,

                    aadhaar:
                        formData.aadhaar,

                    idProofType:
                        formData.idProofType,

                    photo:
                        formData.photo,

                    idProofPhoto:
                        formData.idProofPhoto,

                    isBatsman:
                        formData.isBatsman,

                    isBowler:
                        formData.isBowler,

                    isAllRounder:
                        !!(formData.isBatsman && formData.isBowler),

                    battingStyle:
                        formData.battingStyle,

                    bowlingArm:
                        formData.bowlingArm,

                    bowlingType:
                        formData.bowlingType,

                    lowerSize:
                        formData.lowerSize,

                    tshirtSize:
                        formData.tshirtSize,

                    jerseyNumber:
                        formData.jerseyNumber,

                    jerseyName:
                        formData.jerseyName,

                    event:
                        formData.event,

                    paymentAmount:
                        700,

                    paymentMethod:
                        'UPI QR',

                    paymentUtr:
                        formData.paymentUtr || '',

                    paymentScreenshot:
                        formData.paymentScreenshot || '',

                    paymentStatus:
                        'Pending Verification'

                });


            await registration.save();


            res.json({

                success: true,

                message:
                    'Registration submitted successfully.',

                registrationId:
                    registration._id

            });


        } catch (err) {

            console.error(
                'Registration error:',
                err
            );

            if (
                err.code === 11000
            ) {

                return res.status(409).json({
                    success: false,
                    message:
                        'This Aadhaar number is already registered.'
                });

            }

            res.status(500).json({

                success: false,

                message:
                    'Registration could not be saved.'

            });

        }

    }
);


// ============================================================
// RAZORPAY CREATE ORDER
// ============================================================

app.post(
    '/create-order',
    submitLimiter,
    concurrencyGuard,
    async (req, res) => {

        try {

            const settings =
                await getSettings();

            if (
                !settings.registrationOpen
            ) {

                return res.status(403).json({
                    error:
                        'Registration is currently closed.'
                });

            }

            if (!razorpay) {

                return res.status(500).json({
                    error:
                        'Razorpay is not configured on the server.'
                });

            }

            const aadhaar =
                String(
                    req.body.aadhaar || ''
                ).trim();


            if (
                !/^\d{12}$/.test(
                    aadhaar
                )
            ) {

                return res.status(400).json({
                    error:
                        'Please enter a valid 12-digit Aadhaar number.'
                });

            }


            const existing =
                await Registration.findById(
                    aadhaar
                );


            if (existing) {

                return res.status(409).json({
                    error:
                        'A registration with this Aadhaar number already exists.'
                });

            }


            // ₹700
            // 70000 paise

            const amount =
                70000;


            const order =
                await razorpay.orders.create({

                    amount:

                        amount,

                    currency:

                        'INR',

                    receipt:

                        `MPL-${aadhaar}`,

                    notes: {

                        event:
                            'MPL Registration',

                        aadhaar:
                            aadhaar

                    }

                });


            return res.json({

                id:
                    order.id,

                amount:
                    order.amount,

                currency:
                    order.currency,

                keyId:
                    process.env.RAZORPAY_KEY_ID

            });


        } catch (err) {

            console.error(
                'Razorpay order error:',
                err
            );

            return res.status(500).json({

                error:
                    'Could not create Razorpay payment order. Check the server logs.'

            });

        }

    }
);


// ============================================================
// RAZORPAY PAYMENT VERIFICATION
// ============================================================

app.post(
    '/verify-payment',
    submitLimiter,
    concurrencyGuard,
    async (req, res) => {

        try {

            if (!razorpay) {

                return res.status(500).json({

                    success: false,

                    message:
                        'Razorpay is not configured on the server.'

                });

            }


            if (
                !process.env.RAZORPAY_KEY_SECRET
            ) {

                return res.status(500).json({

                    success: false,

                    message:
                        'Razorpay secret is not configured on the server.'

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

                    message:
                        'Incomplete payment verification data.'

                });

            }


            const generatedSignature =
                crypto
                    .createHmac(
                        'sha256',
                        process.env
                            .RAZORPAY_KEY_SECRET
                    )
                    .update(
                        `${razorpay_order_id}|${razorpay_payment_id}`
                    )
                    .digest('hex');


            if (
                generatedSignature !==
                razorpay_signature
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        'Payment verification failed.'

                });

            }


            const razorpayOrder =
                await razorpay.orders.fetch(
                    razorpay_order_id
                );


            if (

                Number(
                    razorpayOrder.amount
                ) !== 70000 ||

                razorpayOrder.currency !==
                    'INR'

            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        'Payment amount could not be verified.'

                });

            }


            const aadhaar =
                String(
                    formData.aadhaar || ''
                ).trim();


            if (
                !/^\d{12}$/.test(
                    aadhaar
                )
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        'Invalid Aadhaar number.'

                });

            }


            const existing =
                await Registration.findById(
                    aadhaar
                );


            if (existing) {

                return res.status(409).json({

                    success: false,

                    message:
                        'A registration with this Aadhaar number already exists.'

                });

            }


            const registration =
                new Registration({

                    _id:
                        aadhaar,

                    name:
                        formData.name,

                    dob:
                        formData.dob,

                    fatherName:
                        formData.fatherName,

                    email:
                        formData.email,

                    phone:
                        formData.phone,

                    address:
                        formData.address,

                    bloodGroup:
                        formData.bloodGroup,

                    aadhaar:
                        aadhaar,

                    idProofType:
                        formData.idProofType,

                    photo:
                        formData.photo,

                    idProofPhoto:
                        formData.idProofPhoto,

                    isBatsman:
                        formData.isBatsman,

                    isBowler:
                        formData.isBowler,

                    isAllRounder:
                        !!(formData.isBatsman && formData.isBowler),

                    battingStyle:
                        formData.battingStyle,

                    bowlingArm:
                        formData.bowlingArm,

                    bowlingType:
                        formData.bowlingType,

                    lowerSize:
                        formData.lowerSize,

                    tshirtSize:
                        formData.tshirtSize,

                    jerseyNumber:
                        formData.jerseyNumber,

                    jerseyName:
                        formData.jerseyName,

                    event:
                        formData.event,

                    paymentAmount:
                        700,

                    paymentMethod:
                        'Razorpay',

                    razorpayOrderId:
                        razorpay_order_id,

                    razorpayPaymentId:
                        razorpay_payment_id,

                    razorpaySignature:
                        razorpay_signature,

                    paymentStatus:
                        'Paid'

                });


            await registration.save();


            return res.json({

                success: true,

                message:
                    'Payment successful. MPL registration confirmed!',

                registrationId:
                    registration._id

            });


        } catch (err) {

            console.error(
                'Payment verification/registration error:',
                err
            );


            if (
                err.code === 11000
            ) {

                return res.status(409).json({

                    success: false,

                    message:
                        'This Aadhaar number is already registered.'

                });

            }


            return res.status(500).json({

                success: false,

                message:
                    'Payment was received, but registration could not be saved. Please contact the committee.'

            });

        }

    }
);


// ============================================================
// ADMIN AUTHENTICATION
// ============================================================

function checkAdminAuth(
    req,
    res,
    next
) {

    const auth =
        req.headers.authorization;


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


    try {

        const decoded =
            Buffer
                .from(
                    auth.split(' ')[1],
                    'base64'
                )
                .toString();


        const separatorIndex =
            decoded.indexOf(':');


        if (
            separatorIndex === -1
        ) {

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

            user ===
                process.env.ADMIN_USER &&

            pass ===
                process.env.ADMIN_PASSWORD

        ) {

            return next();

        }


    } catch (err) {

        console.error(
            'Admin authentication error:',
            err
        );

    }


    res.set(
        'WWW-Authenticate',
        'Basic realm="Admin"'
    );

    return res.status(401).send(
        'Wrong username or password'
    );

}


// ============================================================
// HTML ESCAPE HELPER
// ============================================================

function escapeHtml(value) {

    return String(
        value ?? ''
    )
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');

}


// ============================================================
// ADMIN PAGE
// ============================================================

app.get(
    '/admin',
    adminLimiter,
    checkAdminAuth,
    async (req, res) => {

        try {

            const settings =
                await getSettings();


            const registrations =
                await Registration
                    .find()
                    .sort({
                        createdAt: -1
                    });


            const rows =
                registrations
                    .map(r => {

                        const id =
                            escapeHtml(
                                r.aadhaar
                            );


                        const name =
                            escapeHtml(
                                r.name
                            );


                        return `

<tr>

    <td>

        ${
            r.photo

                ? `<img
                    src="${r.photo}"
                    style="
                        width:50px;
                        height:50px;
                        object-fit:cover;
                        border-radius:5px;
                    "
                >`

                : ''
        }

    </td>


    <td>

        ${
            r.idProofPhoto

                ? `<a
                    href="${r.idProofPhoto}"
                    target="_blank"
                >
                    <img
                        src="${r.idProofPhoto}"
                        style="
                            width:50px;
                            height:50px;
                            object-fit:cover;
                            border-radius:5px;
                        "
                    >
                </a>`

                : ''
        }

    </td>


    <td>
        ${escapeHtml(r.name)}
    </td>


    <td>
        ${escapeHtml(r.dob)}
    </td>


    <td>
        ${escapeHtml(r.fatherName)}
    </td>


    <td>
        ${escapeHtml(r.phone)}
    </td>


    <td>
        ${escapeHtml(r.email)}
    </td>


    <td>
        ${escapeHtml(r.bloodGroup)}
    </td>


    <td>

        ${[
            r.isBatsman
                ? 'Batsman'
                : '',

            r.isBowler
                ? 'Bowler'
                : '',

            r.isAllRounder
                ? 'All Rounder'
                : ''

        ]
            .filter(Boolean)
            .join(', ')}

    </td>


    <td>
        ${escapeHtml(r.battingStyle)}
    </td>


    <td>
        ${escapeHtml(r.bowlingType)}
    </td>


    <td>

        ${escapeHtml(
            r.jerseyNumber
        )}

        ${escapeHtml(
            r.jerseyName
        )}

    </td>


    <td>
        ${escapeHtml(r.event)}
    </td>


    <td>
        ₹${r.paymentAmount || 700}
    </td>


    <td>
        ${escapeHtml(r.paymentUtr)}
    </td>


    <td>

        <span
            style="
                font-weight:bold;
                ${
                    r.paymentStatus === 'Paid'
                        ? 'color:green;'
                        : 'color:#B5462F;'
                }
            "
        >
            ${escapeHtml(
                r.paymentStatus
            )}
        </span>

    </td>


<td>

    ${
        r.createdAt

            ? escapeHtml(
                new Date(r.createdAt).toLocaleString('en-IN', {
                    timeZone: 'Asia/Kolkata',
                    day: '2-digit',
                    month: '2-digit',
                    year: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                    hour12: true
                })
            )

            : ''
    }

</td>


    <td>

        <div
            style="
                display:flex;
                gap:6px;
                flex-direction:column;
            "
        >

            <button
                onclick="editRegistration('${id}')"
                style="
                    background:#16342B;
                    color:white;
                    border:none;
                    padding:7px 12px;
                    border-radius:4px;
                    cursor:pointer;
                "
            >
                Edit
            </button>


            <form
                method="POST"
                action="/admin/delete-registration/${id}"
                onsubmit="return confirm('Delete registration for ${name}? This cannot be undone.');"
                style="margin:0;"
            >

                <button
                    type="submit"
                    style="
                        background:#B5462F;
                        color:white;
                        border:none;
                        padding:7px 12px;
                        border-radius:4px;
                        cursor:pointer;
                    "
                >
                    Delete
                </button>

            </form>

        </div>

    </td>

</tr>

`;

                    })
                    .join('');


            res.send(`

<!DOCTYPE html>

<html>

<head>

<meta
    charset="UTF-8"
>

<meta
    name="viewport"
    content="width=device-width, initial-scale=1.0"
>

<title>
    Registrations
</title>


<style>

* {
    box-sizing: border-box;
}

body {

    font-family:
        Arial,
        sans-serif;

    padding:24px;

    margin:0;

    background:#ffffff;

    color:#111;

}

h2 {

    margin-top:0;

    margin-bottom:20px;

}

.admin-top {

    display:flex;

    flex-wrap:wrap;

    gap:10px;

    margin-bottom:20px;

}

.btn {

    display:inline-block;

    padding:11px 18px;

    border:none;

    cursor:pointer;

    text-decoration:none;

    font-weight:bold;

    font-size:14px;

}

.add-btn {

    background:#16342B;

    color:white;

}

.csv-btn {

    background:#D8A33C;

    color:#0E241E;

}

.auction-btn {

    background:#16342B;

    color:white;

}

.status-box {

    display:flex;

    align-items:center;

    flex-wrap:wrap;

    gap:14px;

    padding:14px 18px;

    margin-bottom:20px;

    border-radius:6px;

    background:
        ${settings.registrationOpen
            ? '#e7f3ea'
            : '#fbe9e7'};

    border:
        1px solid
        ${settings.registrationOpen
            ? '#16342B'
            : '#B5462F'};

}

.status-text {

    font-weight:bold;

    color:
        ${settings.registrationOpen
            ? '#16342B'
            : '#B5462F'};

}

table {

    border-collapse:collapse;

    width:100%;

    margin-top:16px;

    min-width:1500px;

}

.table-wrapper {

    overflow-x:auto;

    width:100%;

}

th,
td {

    border:1px solid #ccc;

    padding:8px 12px;

    text-align:left;

    font-size:14px;

    vertical-align:middle;

}

th {

    background:#16342B;

    color:white;

    position:sticky;

    top:0;

}

tr:nth-child(even) {

    background:#f6f3ea;

}


/* ============================================================
   MODAL
   ============================================================ */

.modal {

    display:none;

    position:fixed;

    z-index:9999;

    left:0;

    top:0;

    width:100%;

    height:100%;

    background:
        rgba(0,0,0,0.65);

    overflow:auto;

}

.modal-content {

    background:white;

    width:
        min(950px, 94%);

    margin:30px auto;

    border-radius:8px;

    padding:25px;

    box-shadow:
        0 10px 40px
        rgba(0,0,0,0.3);

}

.modal-header {

    display:flex;

    justify-content:space-between;

    align-items:center;

    margin-bottom:20px;

}

.modal-header h2 {

    margin:0;

}

.close {

    font-size:30px;

    cursor:pointer;

    line-height:1;

}

.form-grid {

    display:grid;

    grid-template-columns:
        repeat(2, 1fr);

    gap:15px;

}

.form-group {

    display:flex;

    flex-direction:column;

}

.form-group.full {

    grid-column:
        1 / -1;

}

.form-group label {

    font-weight:bold;

    margin-bottom:6px;

    font-size:14px;

}

.form-group input,
.form-group select,
.form-group textarea {

    padding:10px;

    border:
        1px solid #bbb;

    border-radius:4px;

    font-size:14px;

}

.form-group textarea {

    min-height:80px;

    resize:vertical;

}

.checkbox-group {

    display:flex;

    gap:20px;

    align-items:center;

    padding-top:10px;

}

.checkbox-group label {

    display:flex;

    align-items:center;

    gap:6px;

    font-weight:normal;

}

.form-actions {

    display:flex;

    gap:10px;

    justify-content:flex-end;

    margin-top:25px;

    padding-top:20px;

    border-top:
        1px solid #ddd;

}

.save-btn {

    background:#16342B;

    color:white;

    padding:11px 22px;

    border:none;

    border-radius:4px;

    cursor:pointer;

    font-weight:bold;

}

.cancel-btn {

    background:#ddd;

    color:#111;

    padding:11px 22px;

    border:none;

    border-radius:4px;

    cursor:pointer;

}

.message {

    margin-top:10px;

    padding:10px;

    border-radius:4px;

    display:none;

}

.success {

    background:#e7f3ea;

    color:#16342B;

}

.error {

    background:#fbe9e7;

    color:#B5462F;

}

.loading {

    opacity:0.6;

    pointer-events:none;

}

@media(max-width:700px) {

    body {
        padding:12px;
    }

    .form-grid {

        grid-template-columns:1fr;

    }

    .form-group.full {

        grid-column:auto;

    }

}

</style>

</head>


<body>


<h2>
    Registrations (${registrations.length} total)
</h2>


<!-- ========================================================
     STATUS
     ======================================================== -->

<div class="status-box">

    <span class="status-text">

        Registration is currently
        ${
            settings.registrationOpen
                ? 'OPEN'
                : 'CLOSED'
        }

    </span>


    <form
        method="POST"
        action="/admin/toggle-registration"
        style="margin:0;"
    >

        <button
            type="submit"
            class="btn"
            style="
                background:
                    ${
                        settings.registrationOpen
                            ? '#B5462F'
                            : '#16342B'
                    };
                color:white;
            "
        >

            ${
                settings.registrationOpen
                    ? 'Close Registration'
                    : 'Open Registration'
            }

        </button>

    </form>

</div>


<!-- ========================================================
     ADMIN BUTTONS
     ======================================================== -->

<div class="admin-top">

    <button
        class="btn add-btn"
        onclick="openAddModal()"
    >
        + Add Registration
    </button>


    <a
        class="btn csv-btn"
        href="/admin/export"
    >
        Download CSV
    </a>


    <a
        class="btn auction-btn"
        href="/admin/export-auction"
    >
        Download for Cricauction
    </a>

</div>


<!-- ========================================================
     TABLE
     ======================================================== -->

<div class="table-wrapper">

<table>

<tr>

<th>
    Photo
</th>

<th>
    ID Photo
</th>

<th>
    Name
</th>

<th>
    DOB
</th>

<th>
    Father's Name
</th>

<th>
    Phone
</th>

<th>
    Email
</th>

<th>
    Blood Group
</th>

<th>
    Role
</th>

<th>
    Batting
</th>

<th>
    Bowling
</th>

<th>
    Jersey
</th>

<th>
    Event
</th>

<th>
    Fee
</th>

<th>
    UTR
</th>

<th>
    Payment Status
</th>

<th>
    Date
</th>

<th>
    Action
</th>

</tr>


${rows}


</table>

</div>


<!-- ========================================================
     ADD / EDIT MODAL
     ======================================================== -->

<div
    id="registrationModal"
    class="modal"
>

<div class="modal-content">


<div class="modal-header">

    <h2 id="modalTitle">
        Add Registration
    </h2>

    <span
        class="close"
        onclick="closeModal()"
    >
        &times;
    </span>

</div>


<form
    id="registrationForm"
>


<div class="form-grid">


<!-- Aadhaar -->

<div class="form-group">

    <label>
        Aadhaar Number *
    </label>

    <input
        type="text"
        id="aadhaar"
        name="aadhaar"
        maxlength="12"
        pattern="\\d{12}"
        required
    >

</div>


<!-- Name -->

<div class="form-group">

    <label>
        Name *
    </label>

    <input
        type="text"
        id="name"
        name="name"
        required
    >

</div>


<!-- DOB -->

<div class="form-group">

    <label>
        Date of Birth
    </label>

    <input
        type="date"
        id="dob"
        name="dob"
    >

</div>


<!-- Father's Name -->

<div class="form-group">

    <label>
        Father's Name
    </label>

    <input
        type="text"
        id="fatherName"
        name="fatherName"
    >

</div>


<!-- Phone -->

<div class="form-group">

    <label>
        Phone
    </label>

    <input
        type="text"
        id="phone"
        name="phone"
    >

</div>


<!-- Email -->

<div class="form-group">

    <label>
        Email
    </label>

    <input
        type="email"
        id="email"
        name="email"
    >

</div>


<!-- Blood -->

<div class="form-group">

    <label>
        Blood Group
    </label>

    <input
        type="text"
        id="bloodGroup"
        name="bloodGroup"
    >

</div>


<!-- ID Proof Type -->

<div class="form-group">

    <label>
        ID Proof Type
    </label>

    <select
        id="idProofType"
        name="idProofType"
    >

        <option value="">
            Select
        </option>

        <option value="Aadhaar">
            Aadhaar
        </option>

        <option value="PAN">
            PAN
        </option>

        <option value="Driving Licence">
            Driving Licence
        </option>

        <option value="Voter ID">
            Voter ID
        </option>

        <option value="Other">
            Other
        </option>

    </select>

</div>


<!-- Address -->

<div class="form-group full">

    <label>
        Address
    </label>

    <textarea
        id="address"
        name="address"
    ></textarea>

</div>


<!-- Role -->

<div class="form-group">

    <label>
        Player Role
    </label>

    <div class="checkbox-group">

        <label>

            <input
                type="checkbox"
                id="isBatsman"
                name="isBatsman"
            >

            Batsman

        </label>


        <label>

            <input
                type="checkbox"
                id="isBowler"
                name="isBowler"
            >

            Bowler

        </label>

        <label>

            <input
                type="checkbox"
                id="isAllRounder"
                name="isAllRounder"
            >

            All Rounder

        </label>

    </div>

</div>


<!-- Batting -->

<div class="form-group">

    <label>
        Batting Style
    </label>

    <input
        type="text"
        id="battingStyle"
        name="battingStyle"
        placeholder="Right Hand / Left Hand"
    >

</div>


<!-- Bowling Arm -->

<div class="form-group">

    <label>
        Bowling Arm
    </label>

    <input
        type="text"
        id="bowlingArm"
        name="bowlingArm"
        placeholder="Right Arm / Left Arm"
    >

</div>


<!-- Bowling Type -->

<div class="form-group">

    <label>
        Bowling Type
    </label>

    <input
        type="text"
        id="bowlingType"
        name="bowlingType"
        placeholder="Fast / Medium / Spin"
    >

</div>


<!-- Lower -->

<div class="form-group">

    <label>
        Trouser / Lower Size
    </label>

    <input
        type="text"
        id="lowerSize"
        name="lowerSize"
    >

</div>


<!-- T-Shirt -->

<div class="form-group">

    <label>
        T-Shirt Size
    </label>

    <input
        type="text"
        id="tshirtSize"
        name="tshirtSize"
    >

</div>


<!-- Jersey Number -->

<div class="form-group">

    <label>
        Jersey Number
    </label>

    <input
        type="text"
        id="jerseyNumber"
        name="jerseyNumber"
    >

</div>


<!-- Jersey Name -->

<div class="form-group">

    <label>
        Jersey Name
    </label>

    <input
        type="text"
        id="jerseyName"
        name="jerseyName"
    >

</div>


<!-- Event -->

<div class="form-group">

    <label>
        Event
    </label>

    <input
        type="text"
        id="event"
        name="event"
        value="mpl"
    >

</div>


<!-- Payment Amount -->

<div class="form-group">

    <label>
        Payment Amount
    </label>

    <input
        type="number"
        id="paymentAmount"
        name="paymentAmount"
        value="700"
    >

</div>


<!-- Payment Method -->

<div class="form-group">

    <label>
        Payment Method
    </label>

    <select
        id="paymentMethod"
        name="paymentMethod"
    >

        <option value="UPI QR">
            UPI QR
        </option>

        <option value="Razorpay">
            Razorpay
        </option>

        <option value="Cash">
            Cash
        </option>

        <option value="Bank Transfer">
            Bank Transfer
        </option>

        <option value="Other">
            Other
        </option>

    </select>

</div>


<!-- UTR -->

<div class="form-group">

    <label>
        Payment UTR
    </label>

    <input
        type="text"
        id="paymentUtr"
        name="paymentUtr"
    >

</div>


<!-- Payment Status -->

<div class="form-group">

    <label>
        Payment Status
    </label>

    <select
        id="paymentStatus"
        name="paymentStatus"
    >

        <option value="Pending Verification">
            Pending Verification
        </option>

        <option value="Paid">
            Paid
        </option>

        <option value="Failed">
            Failed
        </option>

    </select>

</div>


<!-- Player Photo -->

<div class="form-group">

    <label>
        Player Photo
    </label>

    <input
        type="file"
        id="photoFile"
        accept="image/*"
    >

    <small>
        Select a photo to add/change the player photo.
    </small>

</div>


<!-- ID Photo -->

<div class="form-group">

    <label>
        ID Proof Photo
    </label>

    <input
        type="file"
        id="idProofPhotoFile"
        accept="image/*"
    >

    <small>
        Select a photo to add/change ID proof.
    </small>

</div>


</div>


<div
    id="formMessage"
    class="message"
></div>


<div class="form-actions">

    <button
        type="button"
        class="cancel-btn"
        onclick="closeModal()"
    >
        Cancel
    </button>


    <button
        type="submit"
        class="save-btn"
        id="saveButton"
    >
        Save Registration
    </button>

</div>


</form>


</div>

</div>


<script>

// ============================================================
// MODAL VARIABLES
// ============================================================

let editingId = null;


// ============================================================
// OPEN ADD
// ============================================================

function openAddModal() {

    editingId = null;

    document.getElementById(
        'modalTitle'
    ).textContent =
        'Add Registration';


    document.getElementById(
        'saveButton'
    ).textContent =
        'Add Registration';


    document.getElementById(
        'registrationForm'
    ).reset();


    document.getElementById(
        'aadhaar'
    ).disabled = false;


    document.getElementById(
        'event'
    ).value = 'mpl';


    document.getElementById(
        'paymentAmount'
    ).value = '700';


    document.getElementById(
        'paymentMethod'
    ).value = 'UPI QR';


    document.getElementById(
        'paymentStatus'
    ).value =
        'Pending Verification';


    clearMessage();


    document.getElementById(
        'registrationModal'
    ).style.display =
        'block';

}


// ============================================================
// OPEN EDIT
// ============================================================

async function editRegistration(id) {

    try {

        editingId = id;

        document.getElementById(
            'modalTitle'
        ).textContent =
            'Edit Registration';


        document.getElementById(
            'saveButton'
        ).textContent =
            'Update Registration';


        clearMessage();


        document.getElementById(
            'registrationModal'
        ).style.display =
            'block';


        const response =
            await fetch(
                '/admin/registration/' +
                encodeURIComponent(id)
            );


        if (!response.ok) {

            throw new Error(
                'Could not load registration.'
            );

        }


        const result =
            await response.json();


        if (!result.success) {

            throw new Error(
                result.message ||
                'Could not load registration.'
            );

        }


        const r =
            result.registration;


        document.getElementById(
            'aadhaar'
        ).value =
            r.aadhaar || '';


        document.getElementById(
            'aadhaar'
        ).disabled = true;


        document.getElementById(
            'name'
        ).value =
            r.name || '';


        document.getElementById(
            'dob'
        ).value =
            r.dob || '';


        document.getElementById(
            'fatherName'
        ).value =
            r.fatherName || '';


        document.getElementById(
            'phone'
        ).value =
            r.phone || '';


        document.getElementById(
            'email'
        ).value =
            r.email || '';


        document.getElementById(
            'bloodGroup'
        ).value =
            r.bloodGroup || '';


        document.getElementById(
            'idProofType'
        ).value =
            r.idProofType || '';


        document.getElementById(
            'address'
        ).value =
            r.address || '';


        document.getElementById(
            'isBatsman'
        ).checked =
            !!r.isBatsman;


        document.getElementById(
            'isBowler'
        ).checked =
            !!r.isBowler;


        document.getElementById(
            'isAllRounder'
        ).checked =
            !!r.isAllRounder;


        document.getElementById(
            'battingStyle'
        ).value =
            r.battingStyle || '';


        document.getElementById(
            'bowlingArm'
        ).value =
            r.bowlingArm || '';


        document.getElementById(
            'bowlingType'
        ).value =
            r.bowlingType || '';


        document.getElementById(
            'lowerSize'
        ).value =
            r.lowerSize || '';


        document.getElementById(
            'tshirtSize'
        ).value =
            r.tshirtSize || '';


        document.getElementById(
            'jerseyNumber'
        ).value =
            r.jerseyNumber || '';


        document.getElementById(
            'jerseyName'
        ).value =
            r.jerseyName || '';


        document.getElementById(
            'event'
        ).value =
            r.event || 'mpl';


        document.getElementById(
            'paymentAmount'
        ).value =
            r.paymentAmount ?? 700;


        document.getElementById(
            'paymentMethod'
        ).value =
            r.paymentMethod || 'UPI QR';


        document.getElementById(
            'paymentUtr'
        ).value =
            r.paymentUtr || '';


        document.getElementById(
            'paymentStatus'
        ).value =
            r.paymentStatus ||
            'Pending Verification';


        document.getElementById(
            'photoFile'
        ).value = '';


        document.getElementById(
            'idProofPhotoFile'
        ).value = '';


    } catch (err) {

        console.error(err);

        showMessage(
            err.message ||
            'Could not load registration.',
            true
        );

    }

}


// ============================================================
// CLOSE MODAL
// ============================================================

function closeModal() {

    document.getElementById(
        'registrationModal'
    ).style.display =
        'none';

}


// ============================================================
// CLICK OUTSIDE MODAL
// ============================================================

window.addEventListener(
    'click',
    function(event) {

        const modal =
            document.getElementById(
                'registrationModal'
            );

        if (
            event.target === modal
        ) {

            closeModal();

        }

    }
);


// ============================================================
// MESSAGE
// ============================================================

function clearMessage() {

    const message =
        document.getElementById(
            'formMessage'
        );

    message.style.display =
        'none';

    message.textContent = '';

    message.className =
        'message';

}


function showMessage(
    text,
    isError = false
) {

    const message =
        document.getElementById(
            'formMessage'
        );


    message.textContent =
        text;


    message.className =
        'message ' +
        (
            isError
                ? 'error'
                : 'success'
        );


    message.style.display =
        'block';

}


// ============================================================
// FILE TO DATA URL
// ============================================================

function fileToDataUrl(file) {

    return new Promise(
        (resolve, reject) => {

            if (!file) {

                resolve('');

                return;

            }


            const reader =
                new FileReader();


            reader.onload = () => {

                resolve(
                    reader.result
                );

            };


            reader.onerror =
                reject;


            reader.readAsDataURL(
                file
            );

        }
    );

}


// ============================================================
// SUBMIT ADD / EDIT
// ============================================================

document.getElementById(
    'registrationForm'
).addEventListener(
    'submit',
    async function(event) {

        event.preventDefault();

        clearMessage();


        const saveButton =
            document.getElementById(
                'saveButton'
            );


        saveButton.disabled =
            true;


        saveButton.textContent =
            'Saving...';


        try {

            const photoFile =
                document.getElementById(
                    'photoFile'
                ).files[0];


            const idProofPhotoFile =
                document.getElementById(
                    'idProofPhotoFile'
                ).files[0];


            const newPhoto =
                await fileToDataUrl(
                    photoFile
                );


            const newIdProofPhoto =
                await fileToDataUrl(
                    idProofPhotoFile
                );


            const data = {

                aadhaar:
                    document.getElementById(
                        'aadhaar'
                    ).value.trim(),

                name:
                    document.getElementById(
                        'name'
                    ).value.trim(),

                dob:
                    document.getElementById(
                        'dob'
                    ).value,

                fatherName:
                    document.getElementById(
                        'fatherName'
                    ).value.trim(),

                phone:
                    document.getElementById(
                        'phone'
                    ).value.trim(),

                email:
                    document.getElementById(
                        'email'
                    ).value.trim(),

                bloodGroup:
                    document.getElementById(
                        'bloodGroup'
                    ).value.trim(),

                idProofType:
                    document.getElementById(
                        'idProofType'
                    ).value,

                address:
                    document.getElementById(
                        'address'
                    ).value.trim(),

                isBatsman:
                    document.getElementById(
                        'isBatsman'
                    ).checked,

                isBowler:
                    document.getElementById(
                        'isBowler'
                    ).checked,

                isAllRounder:
                    document.getElementById(
                        'isAllRounder'
                    ).checked,

                battingStyle:
                    document.getElementById(
                        'battingStyle'
                    ).value.trim(),

                bowlingArm:
                    document.getElementById(
                        'bowlingArm'
                    ).value.trim(),

                bowlingType:
                    document.getElementById(
                        'bowlingType'
                    ).value.trim(),

                lowerSize:
                    document.getElementById(
                        'lowerSize'
                    ).value.trim(),

                tshirtSize:
                    document.getElementById(
                        'tshirtSize'
                    ).value.trim(),

                jerseyNumber:
                    document.getElementById(
                        'jerseyNumber'
                    ).value.trim(),

                jerseyName:
                    document.getElementById(
                        'jerseyName'
                    ).value.trim(),

                event:
                    document.getElementById(
                        'event'
                    ).value.trim(),

                paymentAmount:
                    document.getElementById(
                        'paymentAmount'
                    ).value,

                paymentMethod:
                    document.getElementById(
                        'paymentMethod'
                    ).value,

                paymentUtr:
                    document.getElementById(
                        'paymentUtr'
                    ).value.trim(),

                paymentStatus:
                    document.getElementById(
                        'paymentStatus'
                    ).value

            };


            /*
             * Only replace photos when a new photo
             * was selected.
             *
             * This is important when EDITING because
             * otherwise the existing photo would be deleted.
             */

            if (newPhoto) {

                data.photo =
                    newPhoto;

            }


            if (newIdProofPhoto) {

                data.idProofPhoto =
                    newIdProofPhoto;

            }


            let url;

            let method;


            if (editingId) {

                url =
                    '/admin/edit-registration/' +
                    encodeURIComponent(
                        editingId
                    );

                method =
                    'PUT';

            } else {

                url =
                    '/admin/add-registration';

                method =
                    'POST';

            }


            const response =
                await fetch(
                    url,
                    {
                        method: method,

                        headers: {
                            'Content-Type':
                                'application/json'
                        },

                        body:
                            JSON.stringify(
                                data
                            )
                    }
                );


            const result =
                await response.json();


            if (!response.ok) {

                throw new Error(
                    result.message ||
                    result.error ||
                    'Could not save registration.'
                );

            }


            if (!result.success) {

                throw new Error(
                    result.message ||
                    'Could not save registration.'
                );

            }


            showMessage(
                result.message ||
                'Saved successfully.'
            );


            setTimeout(
                () => {

                    window.location.reload();

                },
                800
            );


        } catch (err) {

            console.error(err);

            showMessage(
                err.message ||
                'Something went wrong.',
                true
            );


            saveButton.disabled =
                false;


            saveButton.textContent =
                editingId
                    ? 'Update Registration'
                    : 'Add Registration';

        }

    }
);

</script>


</body>

</html>

        `);


        } catch (err) {

            console.error(
                'Admin page error:',
                err
            );

            res.status(500).send(
                'Could not load registrations.'
            );

        }

    }
);


// ============================================================
// ADMIN: ADD REGISTRATION
// ============================================================

app.post(
    '/admin/add-registration',
    checkAdminAuth,
    async (req, res) => {

        try {

            const data =
                req.body;


            if (!data.aadhaar) {

                return res.status(400).json({

                    success: false,

                    message:
                        'Aadhaar number is required.'

                });

            }


            if (
                !/^\d{12}$/.test(
                    data.aadhaar
                )
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        'Aadhaar number must be exactly 12 digits.'

                });

            }


            const existing =
                await Registration.findById(
                    data.aadhaar
                );


            if (existing) {

                return res.status(409).json({

                    success: false,

                    message:
                        'A registration with this Aadhaar number already exists.'

                });

            }


            const registration =
                new Registration({

                    _id:
                        data.aadhaar,

                    name:
                        data.name || '',

                    dob:
                        data.dob || '',

                    fatherName:
                        data.fatherName || '',

                    email:
                        data.email || '',

                    phone:
                        data.phone || '',

                    address:
                        data.address || '',

                    bloodGroup:
                        data.bloodGroup || '',

                    aadhaar:
                        data.aadhaar,

                    idProofType:
                        data.idProofType || '',

                    photo:
                        data.photo || '',

                    idProofPhoto:
                        data.idProofPhoto || '',

                    isBatsman:
                        data.isBatsman === true ||
                        data.isBatsman === 'true',

                    isBowler:
                        data.isBowler === true ||
                        data.isBowler === 'true',

                    isAllRounder:
                        data.isAllRounder === true ||
                        data.isAllRounder === 'true',

                    battingStyle:
                        data.battingStyle || '',

                    bowlingArm:
                        data.bowlingArm || '',

                    bowlingType:
                        data.bowlingType || '',

                    lowerSize:
                        data.lowerSize || '',

                    tshirtSize:
                        data.tshirtSize || '',

                    jerseyNumber:
                        data.jerseyNumber || '',

                    jerseyName:
                        data.jerseyName || '',

                    event:
                        data.event || 'mpl',

                    paymentAmount:

                        data.paymentAmount !==
                            undefined &&
                        data.paymentAmount !== ''

                            ? Number(
                                data.paymentAmount
                            )

                            : 700,

                    paymentMethod:
                        data.paymentMethod ||
                        'UPI QR',

                    paymentUtr:
                        data.paymentUtr || '',

                    paymentScreenshot:
                        data.paymentScreenshot || '',

                    paymentStatus:
                        data.paymentStatus ||
                        'Pending Verification'

                });


            await registration.save();


            res.json({

                success: true,

                message:
                    'Registration added successfully.',

                registrationId:
                    registration._id

            });


        } catch (err) {

            console.error(
                'Admin add registration error:',
                err
            );


            if (
                err.code === 11000
            ) {

                return res.status(409).json({

                    success: false,

                    message:
                        'This Aadhaar number is already registered.'

                });

            }


            res.status(500).json({

                success: false,

                message:
                    'Could not add registration.'

            });

        }

    }
);


// ============================================================
// ADMIN: GET SINGLE REGISTRATION
// ============================================================

app.get(
    '/admin/registration/:id',
    checkAdminAuth,
    async (req, res) => {

        try {

            const registration =
                await Registration.findById(
                    req.params.id
                );


            if (!registration) {

                return res.status(404).json({

                    success: false,

                    message:
                        'Registration not found.'

                });

            }


            res.json({

                success: true,

                registration:
                    registration

            });


        } catch (err) {

            console.error(
                'Get registration error:',
                err
            );


            res.status(500).json({

                success: false,

                message:
                    'Could not load registration.'

            });

        }

    }
);


// ============================================================
// ADMIN: EDIT REGISTRATION
// ============================================================

app.put(
    '/admin/edit-registration/:id',
    checkAdminAuth,
    async (req, res) => {

        try {

            const data =
                req.body;


            const registration =
                await Registration.findById(
                    req.params.id
                );


            if (!registration) {

                return res.status(404).json({

                    success: false,

                    message:
                        'Registration not found.'

                });

            }


            /*
             * Aadhaar is currently used as MongoDB _id.
             * Therefore we intentionally don't allow
             * changing Aadhaar through this edit form.
             */

            registration.name =
                data.name || '';


            registration.dob =
                data.dob || '';


            registration.fatherName =
                data.fatherName || '';


            registration.email =
                data.email || '';


            registration.phone =
                data.phone || '';


            registration.address =
                data.address || '';


            registration.bloodGroup =
                data.bloodGroup || '';


            registration.idProofType =
                data.idProofType || '';


            /*
             * Don't erase existing photo if no new
             * photo was uploaded.
             */

            if (
                data.photo !== undefined &&
                data.photo !== ''
            ) {

                registration.photo =
                    data.photo;

            }


            if (
                data.idProofPhoto !== undefined &&
                data.idProofPhoto !== ''
            ) {

                registration.idProofPhoto =
                    data.idProofPhoto;

            }


            registration.isBatsman =
                data.isBatsman === true ||
                data.isBatsman === 'true';


            registration.isBowler =
                data.isBowler === true ||
                data.isBowler === 'true';


            registration.isAllRounder =
                data.isAllRounder === true ||
                data.isAllRounder === 'true';


            registration.battingStyle =
                data.battingStyle || '';


            registration.bowlingArm =
                data.bowlingArm || '';


            registration.bowlingType =
                data.bowlingType || '';


            registration.lowerSize =
                data.lowerSize || '';


            registration.tshirtSize =
                data.tshirtSize || '';


            registration.jerseyNumber =
                data.jerseyNumber || '';


            registration.jerseyName =
                data.jerseyName || '';


            registration.event =
                data.event || 'mpl';


            if (

                data.paymentAmount !==
                    undefined &&

                data.paymentAmount !== ''

            ) {

                const amount =
                    Number(
                        data.paymentAmount
                    );


                if (
                    !Number.isNaN(amount)
                ) {

                    registration.paymentAmount =
                        amount;

                }

            }


            registration.paymentMethod =
                data.paymentMethod ||
                'UPI QR';


            registration.paymentUtr =
                data.paymentUtr || '';


            registration.paymentScreenshot =
                data.paymentScreenshot || '';


            registration.paymentStatus =
                data.paymentStatus ||
                'Pending Verification';


            await registration.save();


            res.json({

                success: true,

                message:
                    'Registration updated successfully.'

            });


        } catch (err) {

            console.error(
                'Admin edit registration error:',
                err
            );


            res.status(500).json({

                success: false,

                message:
                    'Could not update registration.'

            });

        }

    }
);


// ============================================================
// DELETE REGISTRATION
// ============================================================

app.post(
    '/admin/delete-registration/:aadhaar',
    adminLimiter,
    checkAdminAuth,
    async (req, res) => {

        try {

            const {
                aadhaar
            } = req.params;


            const deleted =
                await Registration
                    .findByIdAndDelete(
                        aadhaar
                    );


            if (!deleted) {

                return res.status(404).send(
                    'Registration not found.'
                );

            }


            res.redirect(
                '/admin'
            );


        } catch (err) {

            console.error(
                'Error deleting registration:',
                err
            );


            res.status(500).send(
                'Could not delete registration.'
            );

        }

    }
);


// ============================================================
// EXPORT CSV
// ============================================================

app.get(
    '/admin/export',
    adminLimiter,
    checkAdminAuth,
    async (req, res) => {

        try {

            const registrations =
                await Registration
                    .find()
                    .sort({
                        createdAt: -1
                    });


            const baseUrl =
                req.protocol +
                '://' +
                req.get('host');


            let csv =
                'Name,DOB,Father Name,Phone,Email,Address,Blood Group,Aadhaar,ID Proof,Role,Batting Style,Bowling Arm,Bowling Type,Lower Size,T-shirt Size,Jersey Number,Jersey Name,Event,Payment Amount,Payment UTR,Payment Status,Player Photo URL,ID Proof Photo URL,Date\n';


            registrations.forEach(r => {

                const role =
                    [

                        r.isBatsman
                            ? 'Batsman'
                            : '',

                        r.isBowler
                            ? 'Bowler'
                            : '',

                        r.isAllRounder
                            ? 'All Rounder'
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

                    r.paymentAmount ||
                        700,

                    r.paymentUtr,

                    r.paymentStatus,

                    r.photo
                        ? `${baseUrl}/photo/${r.aadhaar}/player`
                        : '',

                    r.idProofPhoto
                        ? `${baseUrl}/photo/${r.aadhaar}/idproof`
                        : '',

                    r.createdAt
                        ? new Date(r.createdAt).toLocaleString('en-IN', {
                            timeZone: 'Asia/Kolkata',
                            day: '2-digit',
                            month: '2-digit',
                            year: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit',
                            second: '2-digit',
                            hour12: true
                        })
                        : ''

                ]
                    .map(field =>

                        `"${(
                            field || ''
                        )
                            .toString()
                            .replace(
                                /"/g,
                                '""'
                            )}"`

                    )
                    .join(',');


                csv +=
                    row +
                    '\n';

            });


            res.setHeader(
                'Content-Type',
                'text/csv'
            );


            res.setHeader(
                'Content-Disposition',
                'attachment; filename=registrations.csv'
            );


            res.send(
                csv
            );


        } catch (err) {

            console.error(
                err
            );


            res.status(500).send(
                'Export failed.'
            );

        }

    }
);


// ============================================================
// SERVE ADMIN PHOTO
// ============================================================

app.get(
    '/photo/:aadhaar/:type',
    adminLimiter,
    checkAdminAuth,
    async (req, res) => {

        try {

            const {
                aadhaar,
                type
            } = req.params;


            if (
                ![
                    'player',
                    'idproof'
                ].includes(type)
            ) {

                return res.status(400).send(
                    'Invalid photo type.'
                );

            }


            const registration =
                await Registration.findById(
                    aadhaar
                );


            if (!registration) {

                return res.status(404).send(
                    'Registration not found.'
                );

            }


            const dataUrl =
                type === 'player'
                    ? registration.photo
                    : registration.idProofPhoto;


            if (!dataUrl) {

                return res.status(404).send(
                    'No photo on file.'
                );

            }


            const match =
                dataUrl.match(
                    /^data:(image\/[a-zA-Z]+);base64,(.+)$/
                );


            if (!match) {

                return res.status(500).send(
                    'Photo data is in an unexpected format.'
                );

            }


            const contentType =
                match[1];


            const buffer =
                Buffer.from(
                    match[2],
                    'base64'
                );


            res.setHeader(
                'Content-Type',
                contentType
            );


            res.send(
                buffer
            );


        } catch (err) {

            console.error(
                'Error serving photo:',
                err
            );


            res.status(500).send(
                'Could not load photo.'
            );

        }

    }
);


// ============================================================
// PUBLIC PLAYER PHOTO
// ============================================================

app.get(
    '/player-photo/:aadhaar',
    async (req, res) => {

        try {

            const {
                aadhaar
            } = req.params;


            const registration =
                await Registration.findById(
                    aadhaar
                );


            if (
                !registration ||
                !registration.photo
            ) {

                return res.status(404).send(
                    'Photo not found.'
                );

            }


            const match =
                registration.photo.match(
                    /^data:(image\/[a-zA-Z]+);base64,(.+)$/
                );


            if (!match) {

                return res.status(500).send(
                    'Photo data is in an unexpected format.'
                );

            }


            const contentType =
                match[1];


            const buffer =
                Buffer.from(
                    match[2],
                    'base64'
                );


            res.setHeader(
                'Content-Type',
                contentType
            );


            res.send(
                buffer
            );


        } catch (err) {

            console.error(
                'Error serving player photo:',
                err
            );


            res.status(500).send(
                'Could not load photo.'
            );

        }

    }
);


// ============================================================
// CRICAUCTION EXPORT
// ============================================================

app.get(
    '/admin/export-auction',
    adminLimiter,
    checkAdminAuth,
    async (req, res) => {

        try {

            const registrations =
                await Registration
                    .find()
                    .sort({
                        createdAt: 1
                    });


            const baseUrl =
                req.protocol +
                '://' +
                req.get('host');


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
                    r.isAllRounder ||
                    (
                        r.isBatsman &&
                        r.isBowler
                    )
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


            const ageFromDob =
                dob => {

                    if (!dob) {
                        return '';
                    }


                    const birth =
                        new Date(dob);


                    if (
                        isNaN(birth)
                    ) {

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


            const workbook =
                new ExcelJS.Workbook();


            const sheet =
                workbook.addWorksheet(
                    'Sheet1'
                );


            sheet.addRow(
                header
            );


            registrations.forEach(
                (r, i) => {

                    const photoUrl =
                        r.photo

                            ? `${baseUrl}/player-photo/${r.aadhaar}`

                            : '';


                    sheet.addRow([

                        i + 1,

                        r.name || '',

                        r.phone || '',

                        photoUrl,

                        ageFromDob(
                            r.dob
                        ),

                        skillFor(r),

                        r.battingStyle ||
                            '',

                        r.bowlingArm ||
                            '',

                        r.bowlingType ||
                            '',

                        '',

                        r.address ||
                            '',

                        r.jerseyName ||
                            '',

                        r.jerseyNumber ||
                            '',

                        r.tshirtSize ||
                            '',

                        r.lowerSize ||
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


            await workbook.xlsx.write(
                res
            );


            res.end();


        } catch (err) {

            console.error(
                err
            );


            res.status(500).send(
                'Auction export failed.'
            );

        }

    }
);


// ============================================================
// 404
// ============================================================

app.use(
    (req, res) => {

        res.status(404).send(
            'Not found.'
        );

    }
);


// ============================================================
// FINAL ERROR HANDLER
// ============================================================

app.use(
    (
        err,
        req,
        res,
        next
    ) => {

        console.error(
            'Unhandled route error:',
            err
        );


        if (
            res.headersSent
        ) {

            return next(err);

        }


        res.status(500).send(
            'Something went wrong. Please try again.'
        );

    }
);


// ============================================================
// START SERVER
// ============================================================

const PORT =
    process.env.PORT ||
    3000;


app.listen(
    PORT,
    () => {

        console.log(
            'Server running on port ' +
            PORT
        );

    }
);
