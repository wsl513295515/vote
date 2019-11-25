const express = require('express')
const cookieParser = require('cookie-parser')

const port = 3008

const app = express()

app.use(express.static(__dirname + './static'))