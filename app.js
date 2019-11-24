const express = require('express')

const port = 3005

const app = express()

app.use(express.static(__dirname + './static'))